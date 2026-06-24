-- Fix 1: Add expires_at column to messages for timed deletion
ALTER TABLE messages ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT NULL;

-- Fix 2: Create index for expiration queries
CREATE INDEX IF NOT EXISTS idx_messages_expires_at ON messages(expires_at) WHERE expires_at IS NOT NULL;

-- Fix 3: Update mark_message_viewed to only apply view limits to media
CREATE OR REPLACE FUNCTION public.mark_message_viewed(_msg_id uuid, _viewer_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  msg_rec RECORD;
  new_view_count INTEGER;
BEGIN
  -- Get message details
  SELECT * INTO msg_rec FROM messages WHERE id = _msg_id;
  
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Only increment view count for media messages (image, video, file)
  IF msg_rec.message_type IN ('image', 'video', 'file') THEN
    -- Increment view count
    UPDATE messages 
    SET view_count = view_count + 1,
        viewed_at = COALESCE(viewed_at, NOW())
    WHERE id = _msg_id
    RETURNING view_count INTO new_view_count;
  ELSE
    -- For text/audio, just mark as viewed without incrementing count
    UPDATE messages 
    SET viewed_at = COALESCE(viewed_at, NOW())
    WHERE id = _msg_id;
    new_view_count := msg_rec.view_count;
  END IF;

  -- If disappear_after_view flag is set and viewer is not sender, delete immediately
  IF msg_rec.disappear_after_view AND msg_rec.sender_id != _viewer_id THEN
    DELETE FROM message_reactions WHERE message_id = _msg_id;
    DELETE FROM message_deletions WHERE message_id = _msg_id;
    DELETE FROM messages WHERE id = _msg_id;
    RETURN;
  END IF;

  -- View limit check: only for media messages, only by recipient
  IF msg_rec.message_type IN ('image', 'video', 'file') 
     AND msg_rec.view_limit IS NOT NULL 
     AND msg_rec.sender_id != _viewer_id THEN
    IF new_view_count >= msg_rec.view_limit THEN
      -- Delete for everyone when limit reached
      DELETE FROM message_reactions WHERE message_id = _msg_id;
      DELETE FROM message_deletions WHERE message_id = _msg_id;
      DELETE FROM messages WHERE id = _msg_id;
    END IF;
  END IF;
END;
$function$;

-- Fix 4: Create trigger to set expiry on new messages
CREATE OR REPLACE FUNCTION public.tg_set_message_expiry()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  settings_rec RECORD;
BEGIN
  -- Get sender's conversation settings
  SELECT * INTO settings_rec FROM conversation_settings 
  WHERE conversation_id = NEW.conversation_id AND user_id = NEW.sender_id;
  
  IF FOUND AND settings_rec.expiry_seconds IS NOT NULL THEN
    IF settings_rec.expiry_seconds > 0 THEN
      -- Time-based expiry from creation
      NEW.expires_at := NEW.created_at + (settings_rec.expiry_seconds || ' seconds')::interval;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$function$;

-- Fix 5: Create trigger on messages insert
DROP TRIGGER IF EXISTS tg_messages_set_expiry ON messages;
CREATE TRIGGER tg_messages_set_expiry
  BEFORE INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION tg_set_message_expiry();

-- Fix 6: Update purge_expired_messages to use expires_at
CREATE OR REPLACE FUNCTION public.purge_expired_messages()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Delete messages that have expired (based on expires_at)
  DELETE FROM messages 
  WHERE expires_at IS NOT NULL 
    AND expires_at < NOW();
END;
$function$;
