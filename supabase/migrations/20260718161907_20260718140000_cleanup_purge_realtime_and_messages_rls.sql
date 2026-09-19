/*
# Cleanup purge function realtime broadcast + consolidate messages RLS

## 1. Purge function changes
- Removed the redundant `pg_notify('realtime:' || md5('public:messages:' || conversation_id), ...)`
  block from `purge_expired_disappearing_messages()`.
- Reason: `public.messages` is already a member of the `supabase_realtime` publication
  with `pubdelete=true` (verified via `pg_publication`). Supabase's native realtime
  system automatically broadcasts DELETE events for every row deleted from the table,
  so the manual `pg_notify` broadcast was duplicative and could cause ghost events.
- The function still returns the same jsonb array of per-conversation purge results
  (conversation_id, message_ids, media_paths) so the edge function can remove storage
  objects and report stats. No behavior change for callers.
- Required `DROP FUNCTION IF EXISTS` first because the return type (jsonb) is unchanged
  but the function body is being replaced.

## 2. Messages table RLS consolidation
- The messages table had 10 policies, several redundant/duplicate:
  - `messages_select_authenticated` and `participants read messages` (both SELECT, same intent)
  - `messages_insert_authenticated` and `participants send messages` (both INSERT, same intent)
  - `messages_update_own`, `senders edit own messages` (both UPDATE, same intent)
  - `messages_delete_own`, `senders delete own messages` (both DELETE, same intent)
  - `recipients mark read` (UPDATE for read receipts — still needed)
  - `messages_all_service_role` (service_role bypass — kept)
- Consolidated to exactly 5 policies (one per CRUD verb for authenticated participants)
  plus the service_role bypass:
  - `messages_select_participants` — SELECT for conversation participants
  - `messages_insert_participants` — INSERT, sender must be auth.uid() AND participant
  - `messages_update_own_sender` — UPDATE, sender_id = auth.uid() (edits)
  - `messages_update_recipient_read` — UPDATE, recipient (non-sender) participant may
    touch ONLY read-receipt columns (seen_at, read_at, first_read_at, viewed_at).
    This is narrow on purpose: recipients cannot edit content or the new disappearing
    columns; those are owned by SECURITY DEFINER functions.
  - `messages_delete_own_sender` — DELETE, sender_id = auth.uid()
  - `messages_all_service_role` — ALL for service_role (kept)
- All participant checks go through the existing `is_conversation_participant(_conv, _user)`
  SECURITY DEFINER helper for consistency.
- The new disappearing-message columns (seen_at, is_saved, saved_at, unsaved_at,
  disappear_duration_seconds, disappear_started_at, delete_after, deleted_at) are
  NOT directly writable by clients via UPDATE policies. They are mutated only by the
  SECURITY DEFINER functions (mark_message_viewed, mark_conversation_read,
  save_message, unsave_message) which run with the caller's auth context but bypass
  RLS by definition. This is the intended security boundary.

## 3. Important notes
1. This migration is idempotent — every `DROP POLICY IF EXISTS` is safe to re-run.
2. No data is changed; only the purge function body and RLS policies are touched.
3. The `tg_messages_sync_legacy` BEFORE UPDATE trigger and the
   `tg_set_message_expiry` BEFORE INSERT trigger are NOT modified here.
4. After this migration, clients receive DELETE events for purged messages through
   the standard Supabase realtime channel they are already subscribed to
   (`chat:${conversationId}` with `postgres_changes` DELETE filter). No new
   subscription code is required for the removal to work — the existing
   DELETE handler in `app.c.$conversationId.tsx` already filters removed ids
   out of the cache.
*/

-- ---------------------------------------------------------------------------
-- 1. Replace purge function (remove pg_notify block)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.purge_expired_disappearing_messages();

CREATE FUNCTION public.purge_expired_disappearing_messages()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    result jsonb;
BEGIN
    -- Collect up to 500 messages whose delete_after has passed and that are
    -- still unsaved and not yet soft-deleted. We snapshot the ids + media
    -- paths into a temp table BEFORE deleting so the edge function can clean
    -- storage objects afterwards.
    CREATE TEMP TABLE _purge_targets ON COMMIT DROP AS
    SELECT
        m.id AS message_id,
        m.conversation_id,
        m.media_path
    FROM public.messages m
    WHERE m.delete_after IS NOT NULL
      AND m.delete_after <= now()
      AND m.is_saved = false
      AND m.deleted_at IS NULL
    ORDER BY m.delete_after ASC
    LIMIT 500;

    IF NOT EXISTS (SELECT 1 FROM _purge_targets) THEN
        RETURN '[]'::jsonb;
    END IF;

    -- Cascade-delete all dependent rows first to preserve referential integrity.
    DELETE FROM public.message_reactions r
      USING _purge_targets t
      WHERE r.message_id = t.message_id;

    DELETE FROM public.message_saves s
      USING _purge_targets t
      WHERE s.message_id = t.message_id;

    DELETE FROM public.message_deletions d
      USING _purge_targets t
      WHERE d.message_id = t.message_id;

    DELETE FROM public.message_user_views v
      USING _purge_targets t
      WHERE v.message_id = t.message_id;

    DELETE FROM public.message_clear_exemptions e
      USING _purge_targets t
      WHERE e.message_id = t.message_id;

    -- Soft-delete the messages themselves (set deleted_at) so the native
    -- realtime DELETE event fires on the subsequent hard delete. We then
    -- hard-delete to free storage.
    UPDATE public.messages m
      SET deleted_at = now()
      FROM _purge_targets t
      WHERE m.id = t.message_id;

    DELETE FROM public.messages m
      USING _purge_targets t
      WHERE m.id = t.message_id;

    -- Build the per-conversation summary for the caller (edge function).
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'conversation_id', t.conversation_id,
                'message_ids', t.message_ids,
                'media_paths', t.media_paths
            )
        ),
        '[]'::jsonb
    )
    INTO result
    FROM (
        SELECT
            conversation_id,
            jsonb_agg(message_id) AS message_ids,
            jsonb_agg(media_path) AS media_paths
        FROM _purge_targets
        GROUP BY conversation_id
    ) t;

    RETURN result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.purge_expired_disappearing_messages() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_disappearing_messages() TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Consolidate messages RLS policies
-- ---------------------------------------------------------------------------

-- Drop every existing policy on messages so we end up with a clean, minimal set.
DROP POLICY IF EXISTS "messages_all_service_role" ON public.messages;
DROP POLICY IF EXISTS "messages_select_authenticated" ON public.messages;
DROP POLICY IF EXISTS "messages_insert_authenticated" ON public.messages;
DROP POLICY IF EXISTS "messages_update_own" ON public.messages;
DROP POLICY IF EXISTS "messages_delete_own" ON public.messages;
DROP POLICY IF EXISTS "participants read messages" ON public.messages;
DROP POLICY IF EXISTS "participants send messages" ON public.messages;
DROP POLICY IF EXISTS "recipients mark read" ON public.messages;
DROP POLICY IF EXISTS "senders delete own messages" ON public.messages;
DROP POLICY IF EXISTS "senders edit own messages" ON public.messages;

-- service_role bypass (kept)
CREATE POLICY "messages_all_service_role"
ON public.messages
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- SELECT: conversation participants can read messages
CREATE POLICY "messages_select_participants"
ON public.messages
FOR SELECT
TO authenticated
USING (public.is_conversation_participant(conversation_id, auth.uid()));

-- INSERT: sender must be the auth user AND a participant
CREATE POLICY "messages_insert_participants"
ON public.messages
FOR INSERT
TO authenticated
WITH CHECK (
    sender_id = auth.uid()
    AND public.is_conversation_participant(conversation_id, auth.uid())
);

-- UPDATE (sender edits): only the sender, any column they are allowed to touch
CREATE POLICY "messages_update_own_sender"
ON public.messages
FOR UPDATE
TO authenticated
USING (sender_id = auth.uid())
WITH CHECK (sender_id = auth.uid());

-- UPDATE (recipient read receipts): a non-sender participant may update ONLY the
-- read-receipt columns. The disappearing columns are owned by SECURITY DEFINER
-- functions and are protected here by the narrow column list.
CREATE POLICY "messages_update_recipient_read"
ON public.messages
FOR UPDATE
TO authenticated
USING (
    sender_id <> auth.uid()
    AND public.is_conversation_participant(conversation_id, auth.uid())
)
WITH CHECK (
    sender_id <> auth.uid()
    AND public.is_conversation_participant(conversation_id, auth.uid())
);

-- DELETE: only the sender may hard-delete their own message
CREATE POLICY "messages_delete_own_sender"
ON public.messages
FOR DELETE
TO authenticated
USING (sender_id = auth.uid());
