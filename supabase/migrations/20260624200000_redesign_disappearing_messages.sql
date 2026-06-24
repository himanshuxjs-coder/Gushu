-- MIGRATION: Redesigned Per-User Disappearing Messages
-- 1. Update conversation_settings to support per-user expiry and session-exit tracking
ALTER TABLE public.conversation_settings ADD COLUMN IF NOT EXISTS expiry_seconds INT DEFAULT NULL;
ALTER TABLE public.conversation_settings ADD COLUMN IF NOT EXISTS last_exit_at TIMESTAMPTZ DEFAULT NULL;

-- 2. Update messages to track first read event
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS first_read_at TIMESTAMPTZ DEFAULT NULL;

-- 3. Migration: Seed per-user expiry from the conversation default if it hasn't been set yet
DO $$
BEGIN
  UPDATE public.conversation_settings cs
  SET expiry_seconds = c.expiry_seconds
  FROM public.conversations c
  WHERE cs.conversation_id = c.id
    AND cs.expiry_seconds IS NULL;
END $$;

-- 4. RPC function to update session exit time and commit view-once expiration
CREATE OR REPLACE FUNCTION public.commit_view_once_expiration(_conv_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _expiry INT;
BEGIN
  -- 1. Fetch current shared setting
  SELECT expiry_seconds INTO _expiry FROM public.conversations WHERE id = _conv_id;

  -- 2. Commit expiration ONLY if mode is 'After Viewing' (0)
  IF _expiry = 0 THEN
    UPDATE public.messages
    SET expires_at = NOW()
    WHERE conversation_id = _conv_id
      AND first_read_at IS NOT NULL
      AND expires_at IS NULL;
  END IF;

  -- 3. Update last_exit_at for the user
  UPDATE public.conversation_settings
  SET last_exit_at = NOW()
  WHERE conversation_id = _conv_id 
    AND user_id = auth.uid();
END $$;

-- 5. Updated Purge Process
-- Deletes messages ONLY when they have expired for ALL participants and are NOT saved.
CREATE OR REPLACE FUNCTION public.purge_expired_messages()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  DELETE FROM public.messages m
  WHERE m.first_read_at IS NOT NULL
    AND NOT EXISTS (
      -- Skip if ANY participant's retention period hasn't expired yet
      SELECT 1 FROM public.conversation_status sta
      JOIN public.conversation_settings set ON set.conversation_id = m.conversation_id AND set.user_id = sta.user_id
      WHERE sta.conversation_id = m.conversation_id
        AND (
          -- Participant has NO timer OR timer hasn't expired yet
          set.expiry_seconds IS NULL
          OR (set.expiry_seconds > 0 AND (m.first_read_at + (set.expiry_seconds || ' seconds')::interval) > NOW())
          OR (set.expiry_seconds = 0 AND set.last_exit_at IS NULL)
          OR (set.expiry_seconds = 0 AND set.last_exit_at < m.first_read_at)
        )
    )
    AND NOT EXISTS (
      -- Absolutely skip if saved by ANYONE
      SELECT 1 FROM public.message_saves s 
      WHERE s.message_id = m.id
    );
END;
$function$;

-- 6. Cleanup no longer used columns/triggers from previous implementation if they conflict
-- We keep expiry_seconds on conversations as a "starting default" for new participants,
-- but the logic now primarily uses conversation_settings.
-- We can drop the OLD trigger that set expires_at on insert if we want, 
-- but it doesn't hurt to keep it as a fallback until the refactor is complete.
DROP TRIGGER IF EXISTS tg_messages_set_expiry ON public.messages;
