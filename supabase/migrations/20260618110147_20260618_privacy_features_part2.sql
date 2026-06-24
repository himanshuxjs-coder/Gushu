
-- ============================================================
-- Privacy Pack Part 2: remaining tables & columns
-- ============================================================

-- Only add columns not present from part 1
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS incognito_mode   bool    NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS app_pin_hash     text,
  ADD COLUMN IF NOT EXISTS panic_locked     bool    NOT NULL DEFAULT false;

-- View-once and delete-for-all on messages (may already exist)
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS view_once        bool    NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS viewed_at        timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_for_all  bool    NOT NULL DEFAULT false;

-- Helper: mark message as viewed (view-once)
CREATE OR REPLACE FUNCTION mark_message_viewed(_msg_id uuid, _viewer_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE messages
  SET viewed_at = now()
  WHERE id = _msg_id
    AND view_once = true
    AND viewed_at IS NULL
    AND sender_id <> _viewer_id
    AND EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = messages.conversation_id
        AND (c.user1_id = _viewer_id OR c.user2_id = _viewer_id)
    );
END;
$$;

-- Purge expired messages helper
CREATE OR REPLACE FUNCTION purge_expired_messages()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM messages m
  USING conversation_settings cs
  WHERE cs.conversation_id = m.conversation_id
    AND cs.expiry_seconds IS NOT NULL
    AND m.created_at < now() - (cs.expiry_seconds || ' seconds')::interval;
END;
$$;
