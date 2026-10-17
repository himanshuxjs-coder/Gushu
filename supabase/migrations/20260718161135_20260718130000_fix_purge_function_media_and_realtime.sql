/*
# Fix purge_expired_disappearing_messages — collect media paths + realtime broadcast

## Why
The previous version of `purge_expired_disappearing_messages()` deleted message rows
before their media paths could be collected for storage cleanup, and it did not broadcast
realtime `messages_deleted` events to open conversations. This left stale chat-media
objects in storage and ghost messages in clients.

## Changes
1. Drop and recreate `purge_expired_disappearing_messages()` (return type changes from
   integer to jsonb) so it:
   - Collects `(message_id, conversation_id, media_path, media_name)` for all rows
     about to be purged BEFORE deleting them (temp table).
   - Cascades DELETE to dependent rows (reactions, saves, deletions, views, exemptions).
   - Hard-deletes the message rows.
   - Broadcasts a `messages_deleted` realtime event on each affected conversation's
     channel (`chat:{conversation_id}`) with the list of deleted message ids.
   - Returns a JSON array of `{ conversation_id, message_ids, media_paths }` so the
     calling edge function can remove storage objects.
2. Drop `list_media_paths_for_purge` helper (no longer needed — purge returns media info).

## Security
- `purge_expired_disappearing_messages` is SECURITY DEFINER, callable by service_role only.
- No RLS policy changes.
*/

DROP FUNCTION IF EXISTS public.list_media_paths_for_purge(uuid[]);
DROP FUNCTION IF EXISTS public.purge_expired_disappearing_messages();

CREATE OR REPLACE FUNCTION public.purge_expired_disappearing_messages()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows RECORD;
  v_conv_map jsonb;
BEGIN
  -- Collect rows due for purge BEFORE deleting (so we can return media info)
  CREATE TEMP TABLE IF NOT EXISTS _purge_targets ON COMMIT DROP AS
  SELECT
    m.id AS message_id,
    m.conversation_id,
    m.media_path,
    m.media_name
  FROM public.messages m
  WHERE m.delete_after IS NOT NULL
    AND m.delete_after <= now()
    AND m.is_saved = false
    AND m.deleted_at IS NULL
  LIMIT 500;

  -- If nothing to purge, return empty array
  IF NOT EXISTS (SELECT 1 FROM _purge_targets) THEN
    DROP TABLE _purge_targets;
    RETURN '[]'::jsonb;
  END IF;

  -- Cascade deletes for each message id
  FOR v_rows IN SELECT DISTINCT message_id FROM _purge_targets LOOP
    DELETE FROM public.message_reactions WHERE message_id = v_rows.message_id;
    DELETE FROM public.message_saves WHERE message_id = v_rows.message_id;
    DELETE FROM public.message_deletions WHERE message_id = v_rows.message_id;
    DELETE FROM public.message_user_views WHERE message_id = v_rows.message_id;
    DELETE FROM public.message_clear_exemptions WHERE message_id = v_rows.message_id;
    DELETE FROM public.messages WHERE id = v_rows.message_id;
  END LOOP;

  -- Build per-conversation result
  SELECT
    COALESCE(jsonb_agg(
      jsonb_build_object(
        'conversation_id', conversation_id,
        'message_ids', jsonb_agg(message_id),
        'media_paths', jsonb_agg(media_path) FILTER (WHERE media_path IS NOT NULL)
      )
    ), '[]'::jsonb)
  INTO v_conv_map
  FROM _purge_targets
  GROUP BY conversation_id;

  -- Broadcast a messages_deleted event on each conversation channel
  FOR v_rows IN
    SELECT conversation_id, jsonb_agg(message_id) AS msg_ids
    FROM _purge_targets
    GROUP BY conversation_id
  LOOP
    PERFORM pg_notify(
      'realtime:' || md5('public:messages:' || v_rows.conversation_id::text),
      jsonb_build_object(
        'type', 'broadcast',
        'event', 'messages_deleted',
        'payload', jsonb_build_object(
          'conversation_id', v_rows.conversation_id,
          'message_ids', v_rows.msg_ids
        )
      )::text
    );
  END LOOP;

  DROP TABLE _purge_targets;
  RETURN v_conv_map;
END;
$$;

-- Only service_role should call purge
REVOKE EXECUTE ON FUNCTION public.purge_expired_disappearing_messages() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_disappearing_messages() TO service_role;
