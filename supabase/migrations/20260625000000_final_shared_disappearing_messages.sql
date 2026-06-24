-- 1. Ensure conversations.expiry_seconds exists and is used
ALTER TYPE message_kind ADD VALUE IF NOT EXISTS 'system';
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS expiry_seconds INT DEFAULT NULL;

-- 2. Cleanup conversation_settings: we'll still keep last_exit_at, 
-- but we'll stop using per-user expiry_seconds to avoid sync bugs.
ALTER TABLE public.conversation_settings DROP COLUMN IF EXISTS expiry_seconds;

-- 3. Update messages table for static permanence
-- We already have first_read_at and expires_at.
-- expires_at will now be the absolute cutoff set when first read.

-- 4. RPC to commit expiration for view-once messages on exit
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

-- 5. Strict Purge Job
-- Physically deletes unsaved messages that have passed their expires_at
CREATE OR REPLACE FUNCTION public.purge_expired_messages()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Strict deletion for expired messages
  DELETE FROM public.messages m
  WHERE m.expires_at IS NOT NULL 
    AND m.expires_at <= NOW()
    AND NOT EXISTS (
      -- Never delete if saved by ANYONE
      SELECT 1 FROM public.message_saves s 
      WHERE s.message_id = m.id
    );
END;
$function$;

-- 6. Ensure message_type supports 'system'
-- (Assuming it's a text column or we've verified it works as 'text' kind)
-- Just a reminder for the app logic.
