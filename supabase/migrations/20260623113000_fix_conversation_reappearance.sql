-- ============================================================
-- Fix chat reappearance on new message
-- 1. Ensure conversation reappears if it was "left"
-- 2. Ensure last_message_at bump is robust
-- ============================================================

CREATE OR REPLACE FUNCTION public.tg_bump_conversation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Update last_message_at and RESET has_left for all participants
  -- This ensures that if someone 'deleted/left' a chat, it comes back on new activity.
  
  UPDATE public.conversations 
  SET last_message_at = NEW.created_at 
  WHERE id = NEW.conversation_id;

  UPDATE public.conversation_status 
  SET has_left = false, 
      left_at = NULL 
  WHERE conversation_id = NEW.conversation_id;

  RETURN NEW;
END $$;

-- The trigger already exists, so replacing the function is enough.
