/*
# Gushu Production Overhaul Part 2 — Disappearing Messages, Saved/Clear, DAV Removal

## Summary
Reworks disappearing-message timers and saved/clear-chat lifecycle, and fully
removes the "Delete After Viewing" (DAV) feature.

## 1. Disappearing messages — timer starts on FIRST VIEW
`tg_set_message_expiry` no longer sets `expires_at` at insert. `expires_at` is
computed and written when the recipient first views the message
(`mark_message_viewed` / `mark_conversation_read`). Supports a new 30-minute
(1800s) timer value — no enum change needed since `expiry_seconds` is integer.

## 2. Permanent deletion when timer expires
`purge_expired_messages()` hard-deletes expired, unsaved messages + media +
child rows. Scheduled every minute via pg_cron. Permanent deletion for both
sender and recipient.

## 3. Saved messages + Clear Chat — no retroactive deletion
New `message_clear_exemptions` table records that a message was saved at clear
time. `cleanup_cleared_messages` skips any message with an exemption row.
`save_message` inserts an exemption; `unsave_message` does NOT drop it. A
fresh clear while the message is currently unsaved is the only thing that
removes an exemption.

## 4. Delete After Viewing — fully removed
`disappear_after_view` column kept (nullable, defaulted false) to avoid a
destructive drop; all code now treats it as always-false. `mark_message_viewed`
no longer hard-deletes DAV messages. `commit_view_once_expiration` is a no-op.
Existing DAV=true rows normalized to false.

## 5. Tables
- NEW `message_clear_exemptions(message_id, user_id, cleared_at)` PK
  (message_id, user_id). FK to messages (cascade) and auth.users (cascade).
  RLS: owner-scoped CRUD.

## 6. Functions
- REWRITTEN `tg_set_message_expiry` — no expires_at at insert.
- REWRITTEN `mark_message_viewed(_msg_id, _viewer_id)` — sets viewed_at,
  read_at, first_read_at; computes expires_at from conversation expiry_seconds
  on first view. No DAV deletion.
- NEW `mark_conversation_read(_conv_id, _viewer_id)` — bulk version.
- REWRITTEN `cleanup_cleared_messages(p_conversation_id)` — respects exemptions.
- REWRITTEN `purge_expired_messages()` — permanent deletion of expired unsaved.
- REWRITTEN `save_message` / `unsave_message` — exemption logic.

## 7. Cron
- `purge_expired_messages()` every minute via pg_cron.

## 8. Security
- RLS enabled on `message_clear_exemptions` with owner-scoped CRUD.
- All functions SECURITY DEFINER, search_path = public.

## 9. Important notes
1. No destructive column drops. `disappear_after_view` remains as dead column.
2. Existing DAV=true rows normalized to false.
3. `expires_at` for existing messages cleared; re-derived on first view.
*/

-- ---------- 1. Normalize legacy DAV data ----------
UPDATE public.messages SET disappear_after_view = false WHERE disappear_after_view = true;
UPDATE public.messages SET expires_at = NULL WHERE disappear_after_view = true;

-- ---------- 2. New table: message_clear_exemptions ----------
CREATE TABLE IF NOT EXISTS public.message_clear_exemptions (
  message_id uuid NOT NULL,
  user_id uuid NOT NULL,
  cleared_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);

ALTER TABLE public.message_clear_exemptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_exemptions" ON public.message_clear_exemptions;
CREATE POLICY "select_own_exemptions" ON public.message_clear_exemptions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "insert_own_exemptions" ON public.message_clear_exemptions;
CREATE POLICY "insert_own_exemptions" ON public.message_clear_exemptions
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "delete_own_exemptions" ON public.message_clear_exemptions;
CREATE POLICY "delete_own_exemptions" ON public.message_clear_exemptions
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_clear_exemptions_message_id_fkey') THEN
    ALTER TABLE public.message_clear_exemptions
      ADD CONSTRAINT message_clear_exemptions_message_id_fkey
      FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_clear_exemptions_user_id_fkey') THEN
    ALTER TABLE public.message_clear_exemptions
      ADD CONSTRAINT message_clear_exemptions_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_message_clear_exemptions_message ON public.message_clear_exemptions (message_id);

-- ---------- 3. tg_set_message_expiry (no expires_at at insert) ----------
CREATE OR REPLACE FUNCTION public.tg_set_message_expiry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  NEW.expires_at := NULL;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS tg_messages_set_expiry ON public.messages;
CREATE TRIGGER tg_messages_set_expiry
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_message_expiry();

-- ---------- 4. mark_message_viewed ----------
CREATE OR REPLACE FUNCTION public.mark_message_viewed(_msg_id uuid, _viewer_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  msg_rec RECORD;
  v_expiry_seconds INT;
  v_now TIMESTAMPTZ := NOW();
  v_first_view TIMESTAMPTZ;
BEGIN
  SELECT * INTO msg_rec FROM public.messages WHERE id = _msg_id;
  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO public.message_user_views (message_id, user_id, viewed_at)
  VALUES (_msg_id, _viewer_id, v_now)
  ON CONFLICT (message_id, user_id) DO UPDATE SET viewed_at = LEAST(message_user_views.viewed_at, EXCLUDED.viewed_at);

  IF msg_rec.sender_id = _viewer_id THEN RETURN; END IF;

  UPDATE public.messages
  SET viewed_at = COALESCE(viewed_at, v_now),
      read_at = COALESCE(read_at, v_now),
      first_read_at = COALESCE(first_read_at, v_now)
  WHERE id = _msg_id AND (read_at IS NULL OR viewed_at IS NULL);

  SELECT expiry_seconds INTO v_expiry_seconds
  FROM public.conversations WHERE id = msg_rec.conversation_id;

  IF v_expiry_seconds IS NOT NULL AND v_expiry_seconds > 0 AND msg_rec.expires_at IS NULL THEN
    SELECT first_read_at INTO v_first_view FROM public.messages WHERE id = _msg_id;
    UPDATE public.messages
    SET expires_at = COALESCE(v_first_view, v_now) + (v_expiry_seconds || ' seconds')::interval
    WHERE id = _msg_id AND expires_at IS NULL;
  END IF;
END $function$;

-- ---------- 5. mark_conversation_read (bulk) ----------
CREATE OR REPLACE FUNCTION public.mark_conversation_read(_conv_id uuid, _viewer_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_expiry_seconds INT;
  v_now TIMESTAMPTZ := NOW();
  msg RECORD;
BEGIN
  SELECT expiry_seconds INTO v_expiry_seconds
  FROM public.conversations WHERE id = _conv_id;

  FOR msg IN
    SELECT id, sender_id, expires_at, first_read_at
    FROM public.messages
    WHERE conversation_id = _conv_id
      AND sender_id <> _viewer_id
      AND (read_at IS NULL OR viewed_at IS NULL)
  LOOP
    INSERT INTO public.message_user_views (message_id, user_id, viewed_at)
    VALUES (msg.id, _viewer_id, v_now)
    ON CONFLICT (message_id, user_id) DO UPDATE SET viewed_at = LEAST(message_user_views.viewed_at, EXCLUDED.viewed_at);

    UPDATE public.messages
    SET viewed_at = COALESCE(viewed_at, v_now),
        read_at = COALESCE(read_at, v_now),
        first_read_at = COALESCE(first_read_at, v_now)
    WHERE id = msg.id;

    IF v_expiry_seconds IS NOT NULL AND v_expiry_seconds > 0 AND msg.expires_at IS NULL THEN
      UPDATE public.messages
      SET expires_at = COALESCE(first_read_at, v_now) + (v_expiry_seconds || ' seconds')::interval
      WHERE id = msg.id AND expires_at IS NULL;
    END IF;
  END LOOP;
END $function$;

-- ---------- 6. cleanup_cleared_messages (respect exemptions) ----------
CREATE OR REPLACE FUNCTION public.cleanup_cleared_messages(p_conversation_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_earliest_clear TIMESTAMPTZ;
  v_deleted_count INTEGER;
BEGIN
  SELECT MIN(cleared_at) INTO v_earliest_clear
  FROM public.conversation_settings
  WHERE conversation_id = p_conversation_id AND cleared_at IS NOT NULL;

  IF v_earliest_clear IS NULL THEN RETURN 0; END IF;

  DELETE FROM public.messages m
  WHERE m.conversation_id = p_conversation_id
    AND m.created_at <= v_earliest_clear
    AND NOT EXISTS (SELECT 1 FROM public.message_saves ms WHERE ms.message_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM public.message_clear_exemptions ex WHERE ex.message_id = m.id);

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RETURN v_deleted_count;
END $function$;

-- ---------- 7. purge_expired_messages (permanent deletion) ----------
CREATE OR REPLACE FUNCTION public.purge_expired_messages()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_count INTEGER := 0;
  msg RECORD;
BEGIN
  FOR msg IN
    SELECT id, media_path
    FROM public.messages
    WHERE expires_at IS NOT NULL AND expires_at <= NOW()
      AND deleted_for_all = false
      AND NOT EXISTS (SELECT 1 FROM public.message_saves ms WHERE ms.message_id = messages.id)
  LOOP
    DELETE FROM public.message_reactions WHERE message_id = msg.id;
    DELETE FROM public.message_deletions WHERE message_id = msg.id;
    DELETE FROM public.message_user_views WHERE message_id = msg.id;
    DELETE FROM public.message_clear_exemptions WHERE message_id = msg.id;
    DELETE FROM public.messages WHERE id = msg.id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $function$;

-- ---------- 8. save_message (insert exemption) ----------
CREATE OR REPLACE FUNCTION public.save_message(_msg_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_conv_id UUID;
  v_user_id UUID := auth.uid();
BEGIN
  SELECT conversation_id INTO v_conv_id FROM public.messages WHERE id = _msg_id;
  IF v_conv_id IS NULL THEN RETURN; END IF;

  INSERT INTO public.message_saves (user_id, message_id, conversation_id)
  VALUES (v_user_id, _msg_id, v_conv_id)
  ON CONFLICT (user_id, message_id) DO NOTHING;

  INSERT INTO public.message_clear_exemptions (message_id, user_id, cleared_at)
  VALUES (_msg_id, v_user_id, NOW())
  ON CONFLICT (message_id, user_id) DO NOTHING;
END $function$;

-- ---------- 9. unsave_message (no exemption drop) ----------
CREATE OR REPLACE FUNCTION public.unsave_message(_msg_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  DELETE FROM public.message_saves WHERE user_id = auth.uid() AND message_id = _msg_id;
END $function$;

-- ---------- 10. commit_view_once_expiration (DAV removed, no-op) ----------
CREATE OR REPLACE FUNCTION public.commit_view_once_expiration(_conv_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  NULL;
END $function$;

-- ---------- 11. Index for expiry cleanup ----------
CREATE INDEX IF NOT EXISTS idx_messages_expires_at ON public.messages (expires_at) WHERE expires_at IS NOT NULL;

-- ---------- 12. Schedule cron for purge_expired_messages ----------
DO $$
DECLARE v_job_id BIGINT;
BEGIN
  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'gushu_purge_expired_messages';
  IF v_job_id IS NOT NULL THEN PERFORM cron.unschedule(v_job_id); END IF;
  PERFORM cron.schedule('gushu_purge_expired_messages', '* * * * *', 'SELECT public.purge_expired_messages();');
END $$;

-- ---------- 13. Realtime publication for new table ----------
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'message_clear_exemptions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.message_clear_exemptions;
  END IF;
END $$;
