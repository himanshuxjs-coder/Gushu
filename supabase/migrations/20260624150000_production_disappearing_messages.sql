-- MIGRATION: Production-Ready Disappearing Messages
-- 1. Update conversations table
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS expiry_seconds INT DEFAULT NULL;

-- 2. Update messages table
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS expiry_seconds_used INT DEFAULT NULL;
-- Ensure expires_at exists (from previous migrations but safety first)
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT NULL;

-- 3. Optimization Indexes
CREATE INDEX IF NOT EXISTS idx_messages_expires_at ON public.messages(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_message_saves_message_id ON public.message_saves(message_id);

-- 4. Update the trigger function to calculate expiry ONCE based on conversation settings
CREATE OR REPLACE FUNCTION public.tg_set_message_expiry()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_expiry_seconds INT;
BEGIN
  -- 1. Get conversation's current expiry setting
  SELECT expiry_seconds INTO v_expiry_seconds 
  FROM public.conversations 
  WHERE id = NEW.conversation_id;
  
  -- 2. Calculate ONCE and store
  IF v_expiry_seconds IS NOT NULL AND v_expiry_seconds > 0 THEN
    NEW.expiry_seconds_used := v_expiry_seconds;
    -- Use COALESCE because created_at might be NULL during BEFORE INSERT
    NEW.expires_at := COALESCE(NEW.created_at, NOW()) + (v_expiry_seconds || ' seconds')::interval;
  END IF;
  
  RETURN NEW;
END;
$function$;

-- Ensure trigger is active on INSERT
DROP TRIGGER IF EXISTS tg_messages_set_expiry ON public.messages;
CREATE TRIGGER tg_messages_set_expiry
  BEFORE INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_set_message_expiry();

-- 5. Reliable Purge Process using NOT EXISTS
CREATE OR REPLACE FUNCTION public.purge_expired_messages()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Delete messages that have expired AND are NOT saved by anyone
  DELETE FROM public.messages m
  WHERE m.expires_at IS NOT NULL 
    AND m.expires_at < NOW()
    AND NOT EXISTS (
      SELECT 1 FROM public.message_saves s 
      WHERE s.message_id = m.id
    );
END;
$function$;

-- 6. RPC function to safely unsave and potentially delete if already expired
CREATE OR REPLACE FUNCTION public.unsave_message(_msg_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_expires_at TIMESTAMPTZ;
BEGIN
    -- 1. Remove the save
    DELETE FROM public.message_saves
    WHERE user_id = auth.uid() AND message_id = _msg_id;
    
    -- 2. Check if message is now fully unsaved and expired
    SELECT expires_at INTO v_expires_at FROM public.messages WHERE id = _msg_id;
    
    IF v_expires_at IS NOT NULL AND v_expires_at < NOW() THEN
        -- Only delete if NO ONE else has it saved
        IF NOT EXISTS (SELECT 1 FROM public.message_saves WHERE message_id = _msg_id) THEN
            DELETE FROM public.messages WHERE id = _msg_id;
        END IF;
    END IF;
END $$;

-- 7. Migrate existing data (OPTIONAL/BEST EFFORT)
-- We don't bulk update historical messages logic as per requirements ("Only NEW messages should use 7 days")
-- But we can populate conversation expiry_seconds from existing settings if they exist
DO $$
BEGIN
  UPDATE public.conversations c
  SET expiry_seconds = (
    SELECT expiry_seconds 
    FROM public.conversation_settings cs 
    WHERE cs.conversation_id = c.id 
    AND expiry_seconds IS NOT NULL 
    ORDER BY expiry_seconds ASC 
    LIMIT 1
  )
  WHERE expiry_seconds IS NULL;
END $$;
