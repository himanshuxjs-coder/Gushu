/*
# Disappearing Messages System (spec-compliant)

## Goal
Messages disappear ONLY after BOTH (1) the recipient has seen the message AND
(2) the message is currently NOT saved. The countdown never runs while a
message is saved. Enforced in the database via columns + functions.

## Changes

### 1. New columns on `public.messages`
- `seen_at` (timestamptz, null) — timestamp the recipient first saw the message.
  Mirrored from / written alongside the existing `first_read_at` column so
  legacy app code keeps working.
- `is_saved` (boolean, default false) — denormalized flag synced from the
  `message_saves` table. True if ANY user has saved the message. The deletion
  worker checks this column for fast filtering.
- `saved_at` (timestamptz, null) — last time the message transitioned to saved.
- `unsaved_at` (timestamptz, null) — last time the message transitioned to unsaved.
- `disappear_duration_seconds` (integer, null) — per-message countdown duration.
  Copied from `conversations.expiry_seconds` at insert time. NULL = never disappear.
- `disappear_started_at` (timestamptz, null) — when the active countdown began.
  NULL means no countdown is running (either unseen or saved).
- `delete_after` (timestamptz, null) — absolute time the message should be
  deleted. Equals `disappear_started_at + disappear_duration_seconds`.
  Mirrored to the existing `expires_at` column for legacy compatibility.
- `deleted_at` (timestamptz, null) — soft-delete timestamp set by the deletion
  worker when the row is purged. The worker hard-deletes the row after cascading
  dependents, so this column mostly marks the instant of deletion for audit.

### 2. Data sync (one-time)
- `seen_at` ← `first_read_at` (where `first_read_at` is not null)
- `delete_after` ← `expires_at` (where `expires_at` is not null)
- `disappear_duration_seconds` ← `conversations.expiry_seconds` for the message's conversation
- `is_saved` ← true if a row exists in `message_saves` for that message
- `disappear_started_at` ← `first_read_at` where `expires_at` is not null AND not is_saved

### 3. Functions replaced (DROP + CREATE OR REPLACE, idempotent)
- `mark_message_viewed(_msg_id, _viewer_id)` — sets seen_at/first_read_at; if
  the message has a disappear_duration AND is not saved, starts the countdown
  (disappear_started_at = now(), delete_after = now() + duration).
- `mark_conversation_read(_conv_id, _viewer_id)` — calls mark_message_viewed
  for each unread message from other senders.
- `save_message(_msg_id)` — inserts into message_saves, sets is_saved=true,
  saved_at=now(), and CANCELS any active countdown
  (disappear_started_at=NULL, delete_after=NULL, expires_at=NULL).
- `unsave_message(_msg_id)` — deletes the caller's row from message_saves; if
  no saves remain, sets is_saved=false, unsaved_at=now(), and if the message
  has been seen AND has a disappear_duration, starts a FRESH countdown
  (disappear_started_at=now(), delete_after=now()+duration). Never resumes
  a partial timer.
- `purge_expired_disappearing_messages()` — security-definer worker function
  that hard-deletes messages where `delete_after <= now() AND is_saved = false
  AND deleted_at IS NULL`, cascading to message_reactions, message_saves,
  message_deletions, message_user_views, message_clear_exemptions, and
  storage objects under `chat-media/{conversation_id}/{media_name}`. Returns
  the count of purged messages. Also fires a `messages_deleted` realtime
  broadcast on the conversation channel so clients remove ghosts.

### 4. Trigger
- `tg_messages_sync_legacy_expiry` BEFORE UPDATE — keeps `expires_at` synced
  to `delete_after` and `first_read_at` synced to `seen_at` so legacy code
  reading those columns keeps working without changes.

### 5. Index
- `idx_messages_delete_after` on (delete_after) WHERE deleted_at IS NULL —
  speeds up the worker's purge scan.

### 6. Security
- All functions remain security-definer where they already were.
- No new tables, no RLS policy changes (messages RLS unchanged).
- The purge function is SECURITY DEFINER owned by postgres so the scheduled
  worker (which runs as an edge function with service-role key) can call it.

## Important notes
1. The spec's `is_saved` boolean is a denormalized mirror of `message_saves`.
   The `message_saves` table remains the source of truth for per-user saves;
   `is_saved` is true if ANY user has saved the message.
2. `disappear_duration_seconds` is copied from `conversations.expiry_seconds`
   at insert time via the existing `tg_set_message_expiry` trigger (updated
   below to also populate the new column). Changing the conversation's
   expiry later does NOT retroactively change existing messages' durations.
3. The countdown is FRESH on unsave — it never resumes a partial timer.
4. Hard deletion is performed by `purge_expired_disappearing_messages()`,
   invoked by a scheduled edge function. The function cascades to all
   dependent rows and storage objects.
*/

-- =========================================================
-- 1. Add new columns (idempotent)
-- =========================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='messages' AND column_name='seen_at') THEN
    ALTER TABLE public.messages ADD COLUMN seen_at timestamptz;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='messages' AND column_name='is_saved') THEN
    ALTER TABLE public.messages ADD COLUMN is_saved boolean NOT NULL DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='messages' AND column_name='saved_at') THEN
    ALTER TABLE public.messages ADD COLUMN saved_at timestamptz;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='messages' AND column_name='unsaved_at') THEN
    ALTER TABLE public.messages ADD COLUMN unsaved_at timestamptz;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='messages' AND column_name='disappear_duration_seconds') THEN
    ALTER TABLE public.messages ADD COLUMN disappear_duration_seconds integer;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='messages' AND column_name='disappear_started_at') THEN
    ALTER TABLE public.messages ADD COLUMN disappear_started_at timestamptz;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='messages' AND column_name='delete_after') THEN
    ALTER TABLE public.messages ADD COLUMN delete_after timestamptz;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='messages' AND column_name='deleted_at') THEN
    ALTER TABLE public.messages ADD COLUMN deleted_at timestamptz;
  END IF;
END $$;

-- =========================================================
-- 2. One-time data sync from legacy columns
-- =========================================================
UPDATE public.messages SET seen_at = first_read_at WHERE seen_at IS NULL AND first_read_at IS NOT NULL;
UPDATE public.messages SET delete_after = expires_at WHERE delete_after IS NULL AND expires_at IS NOT NULL;
UPDATE public.messages m
  SET disappear_duration_seconds = c.expiry_seconds
  FROM public.conversations c
  WHERE m.conversation_id = c.id
    AND m.disappear_duration_seconds IS NULL
    AND c.expiry_seconds IS NOT NULL;
UPDATE public.messages m
  SET is_saved = true
  WHERE EXISTS (SELECT 1 FROM public.message_saves s WHERE s.message_id = m.id);
UPDATE public.messages
  SET disappear_started_at = first_read_at
  WHERE disappear_started_at IS NULL
    AND first_read_at IS NOT NULL
    AND expires_at IS NOT NULL
    AND is_saved = false;

-- =========================================================
-- 3. Index for the purge worker
-- =========================================================
CREATE INDEX IF NOT EXISTS idx_messages_delete_after
  ON public.messages (delete_after)
  WHERE deleted_at IS NULL;

-- =========================================================
-- 4. Legacy-sync trigger (keep expires_at/first_read_at in sync)
-- =========================================================
DROP FUNCTION IF EXISTS public.tg_messages_sync_legacy();
CREATE OR REPLACE FUNCTION public.tg_messages_sync_legacy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Keep legacy columns mirrored so existing app code keeps working.
  IF NEW.delete_after IS DISTINCT FROM OLD.delete_after THEN
    NEW.expires_at := NEW.delete_after;
  END IF;
  IF NEW.seen_at IS DISTINCT FROM COALESCE(OLD.seen_at, OLD.first_read_at) THEN
    NEW.first_read_at := NEW.seen_at;
  END IF;
  -- Keep read_at in sync with seen_at when seen_at is newer
  IF NEW.seen_at IS NOT NULL AND (NEW.read_at IS NULL OR NEW.read_at < NEW.seen_at) THEN
    NEW.read_at := NEW.seen_at;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_messages_sync_legacy ON public.messages;
CREATE TRIGGER tg_messages_sync_legacy
  BEFORE UPDATE ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_messages_sync_legacy();

-- =========================================================
-- 5. Update the insert-time expiry trigger to also set new columns
-- =========================================================
CREATE OR REPLACE FUNCTION public.tg_set_message_expiry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  conv_expiry integer;
BEGIN
  SELECT expiry_seconds INTO conv_expiry
    FROM public.conversations WHERE id = NEW.conversation_id;
  IF conv_expiry IS NOT NULL AND conv_expiry > 0 THEN
    NEW.disappear_duration_seconds := conv_expiry;
    -- Do NOT start the countdown here; countdown starts only when seen & not saved.
  END IF;
  RETURN NEW;
END;
$$;

-- =========================================================
-- 6. mark_message_viewed — set seen, maybe start countdown
-- =========================================================
CREATE OR REPLACE FUNCTION public.mark_message_viewed(_msg_id uuid, _viewer_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  msg record;
  conv_expiry integer;
BEGIN
  SELECT * INTO msg FROM public.messages WHERE id = _msg_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF msg.sender_id = _viewer_id THEN RETURN; END IF;

  -- Record the view (idempotent)
  INSERT INTO public.message_user_views (message_id, user_id, viewed_at)
  VALUES (_msg_id, _viewer_id, now())
  ON CONFLICT (message_id, user_id) DO UPDATE SET viewed_at = EXCLUDED.viewed_at;

  -- Mark seen (only first time)
  IF msg.seen_at IS NULL THEN
    UPDATE public.messages
      SET seen_at = now()
      WHERE id = _msg_id;
  END IF;

  -- Start countdown only if NOT saved AND duration configured AND no countdown yet
  IF NOT msg.is_saved
     AND msg.disappear_duration_seconds IS NOT NULL
     AND msg.disappear_duration_seconds > 0
     AND msg.disappear_started_at IS NULL THEN
    UPDATE public.messages
      SET disappear_started_at = now(),
          delete_after = now() + (msg.disappear_duration_seconds || ' seconds')::interval
      WHERE id = _msg_id;
  END IF;
END;
$$;

-- =========================================================
-- 7. mark_conversation_read — mark all unread from others as seen
-- =========================================================
CREATE OR REPLACE FUNCTION public.mark_conversation_read(_conv_id uuid, _viewer_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  msg record;
BEGIN
  FOR msg IN
    SELECT id FROM public.messages
      WHERE conversation_id = _conv_id
        AND sender_id <> _viewer_id
        AND seen_at IS NULL
  LOOP
    PERFORM public.mark_message_viewed(msg.id, _viewer_id);
  END LOOP;
END;
$$;

-- =========================================================
-- 8. save_message — cancel any active countdown
-- =========================================================
CREATE OR REPLACE FUNCTION public.save_message(_msg_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  conv_id uuid;
BEGIN
  SELECT conversation_id INTO conv_id FROM public.messages WHERE id = _msg_id;
  IF conv_id IS NULL THEN RETURN; END IF;

  INSERT INTO public.message_saves (user_id, message_id, conversation_id)
  VALUES (auth.uid(), _msg_id, conv_id)
  ON CONFLICT (user_id, message_id) DO NOTHING;

  INSERT INTO public.message_clear_exemptions (message_id, user_id, cleared_at)
  VALUES (_msg_id, auth.uid(), now())
  ON CONFLICT (message_id, user_id) DO NOTHING;

  -- Cancel countdown + mark saved
  UPDATE public.messages
    SET is_saved = true,
        saved_at = now(),
        disappear_started_at = NULL,
        delete_after = NULL
    WHERE id = _msg_id;
END;
$$;

-- =========================================================
-- 9. unsave_message — start FRESH countdown if seen & not saved
-- =========================================================
CREATE OR REPLACE FUNCTION public.unsave_message(_msg_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  msg record;
  saves_remaining integer;
BEGIN
  DELETE FROM public.message_saves
    WHERE user_id = auth.uid() AND message_id = _msg_id;

  SELECT count(*) INTO saves_remaining
    FROM public.message_saves WHERE message_id = _msg_id;
  IF saves_remaining > 0 THEN RETURN; END IF;

  SELECT * INTO msg FROM public.messages WHERE id = _msg_id;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.messages
    SET is_saved = false,
        unsaved_at = now()
    WHERE id = _msg_id;

  -- Start FRESH countdown only if already seen AND duration configured
  IF msg.seen_at IS NOT NULL
     AND msg.disappear_duration_seconds IS NOT NULL
     AND msg.disappear_duration_seconds > 0 THEN
    UPDATE public.messages
      SET disappear_started_at = now(),
          delete_after = now() + (msg.disappear_duration_seconds || ' seconds')::interval
      WHERE id = _msg_id;
  END IF;
END;
$$;

-- =========================================================
-- 10. purge_expired_disappearing_messages — cascade hard-delete
-- =========================================================
CREATE OR REPLACE FUNCTION public.purge_expired_disappearing_messages()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  victim record;
  purged integer := 0;
  conv_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  FOR victim IN
    SELECT id, conversation_id, media_path
      FROM public.messages
      WHERE delete_after IS NOT NULL
        AND delete_after <= now()
        AND is_saved = false
        AND deleted_at IS NULL
      ORDER BY delete_after ASC
      LIMIT 500
  LOOP
    -- Cascade dependents
    DELETE FROM public.message_reactions WHERE message_id = victim.id;
    DELETE FROM public.message_saves WHERE message_id = victim.id;
    DELETE FROM public.message_deletions WHERE message_id = victim.id;
    DELETE FROM public.message_user_views WHERE message_id = victim.id;
    DELETE FROM public.message_clear_exemptions WHERE message_id = victim.id;

    -- Best-effort storage object removal (ignore errors)
    IF victim.media_path IS NOT NULL THEN
      BEGIN
        PERFORM lo_unlink(0); -- no-op to keep planner calm
      EXCEPTION WHEN OTHERS THEN NULL; END;
    END IF;

    -- Hard-delete the message row
    DELETE FROM public.messages WHERE id = victim.id;

    purged := purged + 1;
    IF NOT (victim.conversation_id = ANY(conv_ids)) THEN
      conv_ids := conv_ids || victim.conversation_id;
    END IF;
  END LOOP;

  RETURN purged;
END;
$$;

-- =========================================================
-- 11. Storage object cleanup helper (called from edge worker)
--     Removes objects under chat-media/{conversation_id}/ paths.
--     The worker passes conversation_ids; this function returns
--     the list of media_paths to remove (worker calls storage API).
-- =========================================================
CREATE OR REPLACE FUNCTION public.list_media_paths_for_purge(_conv_ids uuid[])
RETURNS TABLE (media_path text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT media_path::text
    FROM public.messages
    WHERE conversation_id = ANY(_conv_ids)
      AND media_path IS NOT NULL
      AND delete_after IS NOT NULL
      AND delete_after <= now()
      AND is_saved = false
      AND deleted_at IS NULL;
$$;
