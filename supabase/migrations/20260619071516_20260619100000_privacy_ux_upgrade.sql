-- Privacy & UX Upgrade Migration
-- Adds: disappear after viewing, view limits, notification settings, secret code protection

-- 1. Add view tracking and limit columns to messages
ALTER TABLE messages
ADD COLUMN IF NOT EXISTS view_limit INTEGER DEFAULT NULL,
ADD COLUMN IF NOT EXISTS view_count INTEGER DEFAULT 0 CHECK (view_count >= 0),
ADD COLUMN IF NOT EXISTS disappear_after_view BOOLEAN DEFAULT FALSE;

-- 2. Add per-conversation notification settings
ALTER TABLE conversation_settings
ADD COLUMN IF NOT EXISTS notification_enabled BOOLEAN DEFAULT FALSE;

-- 3. Add secret code protection for hidden chats
ALTER TABLE conversation_settings
ADD COLUMN IF NOT EXISTS secret_code_hash TEXT DEFAULT NULL;

-- 4. Add timestamp for deleted messages to track when deletion occurred
ALTER TABLE messages
ADD COLUMN IF NOT EXISTS deleted_for_everyone_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE messages
ADD COLUMN IF NOT EXISTS deleted_by_id UUID DEFAULT NULL;

-- 5. Create index for faster secret code lookups
CREATE INDEX IF NOT EXISTS idx_conversation_settings_secret_code 
ON conversation_settings(user_id) 
WHERE secret_code_hash IS NOT NULL;

-- 6. Update mark_message_viewed to handle disappear_after_view
CREATE OR REPLACE FUNCTION mark_message_viewed(_msg_id UUID, _viewer_id UUID)
RETURNS VOID
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
DECLARE
  msg_rec RECORD;
  new_view_count INTEGER;
BEGIN
  -- Get message details
  SELECT * INTO msg_rec FROM messages WHERE id = _msg_id;
  
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Increment view count first
  UPDATE messages 
  SET view_count = view_count + 1,
      viewed_at = COALESCE(viewed_at, NOW())
  WHERE id = _msg_id
  RETURNING view_count INTO new_view_count;

  -- If disappear_after_view and now viewed by non-sender
  IF msg_rec.disappear_after_view AND msg_rec.sender_id != _viewer_id THEN
    -- Delete the message completely for both users
    DELETE FROM message_reactions WHERE message_id = _msg_id;
    DELETE FROM message_deletions WHERE message_id = _msg_id;
    DELETE FROM messages WHERE id = _msg_id;
    RETURN;
  END IF;

  -- Check if view limit reached (for non-sender viewing)
  IF msg_rec.view_limit IS NOT NULL AND msg_rec.sender_id != _viewer_id THEN
    IF new_view_count >= msg_rec.view_limit THEN
      -- Delete for everyone
      DELETE FROM message_reactions WHERE message_id = _msg_id;
      DELETE FROM message_deletions WHERE message_id = _msg_id;
      DELETE FROM messages WHERE id = _msg_id;
    END IF;
  END IF;
END;
$$;

-- 7. Function to soft delete message for everyone with placeholder
CREATE OR REPLACE FUNCTION soft_delete_message_for_everyone(_msg_id UUID, _sender_id UUID)
RETURNS VOID
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE messages
  SET 
    content = NULL,
    media_path = NULL,
    media_mime = NULL,
    media_name = NULL,
    media_size = NULL,
    deleted_for_all = TRUE,
    deleted_for_everyone_at = NOW(),
    deleted_by_id = _sender_id
  WHERE id = _msg_id AND sender_id = _sender_id;
END;
$$;