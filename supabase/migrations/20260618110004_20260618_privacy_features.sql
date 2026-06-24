
-- ============================================================
-- Gushu Privacy+ Upgrade Pack — database schema
-- ============================================================

-- 1. Incognito mode & app PIN on profiles
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS incognito_mode   bool    NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS app_pin_hash     text,          -- bcrypt hash of app/panic PIN
  ADD COLUMN IF NOT EXISTS panic_locked     bool    NOT NULL DEFAULT false;

-- 2. Per-conversation settings
CREATE TABLE IF NOT EXISTS conversation_settings (
  conversation_id uuid        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL,
  pin_hash        text,                          -- chat-lock PIN (bcrypt)
  is_locked       bool        NOT NULL DEFAULT false,
  is_hidden       bool        NOT NULL DEFAULT false,
  expiry_seconds  int,                           -- NULL = never, else seconds
  theme           text        NOT NULL DEFAULT 'obsidian',
  wallpaper_url   text,
  cleared_at      timestamptz,                   -- hide messages before this timestamp
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

ALTER TABLE conversation_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_conv_settings" ON conversation_settings FOR SELECT
  TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "insert_own_conv_settings" ON conversation_settings FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "update_own_conv_settings" ON conversation_settings FOR UPDATE
  TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "delete_own_conv_settings" ON conversation_settings FOR DELETE
  TO authenticated USING (auth.uid() = user_id);

-- 3. Message deletions (per-user soft-delete)
CREATE TABLE IF NOT EXISTS message_deletions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      uuid        NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL,
  deleted_for_all bool        NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id)
);

ALTER TABLE message_deletions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_deletions" ON message_deletions FOR SELECT
  TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "insert_own_deletions" ON message_deletions FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "delete_own_deletions" ON message_deletions FOR DELETE
  TO authenticated USING (auth.uid() = user_id);

-- 4. Private notes
CREATE TABLE IF NOT EXISTS private_notes (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL,
  content         text        NOT NULL CHECK (char_length(content) <= 2000),
  pinned          bool        NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE private_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_notes" ON private_notes FOR SELECT
  TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "insert_own_notes" ON private_notes FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "update_own_notes" ON private_notes FOR UPDATE
  TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "delete_own_notes" ON private_notes FOR DELETE
  TO authenticated USING (auth.uid() = user_id);

-- 5. Message reactions
CREATE TABLE IF NOT EXISTS message_reactions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      uuid        NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL,
  emoji           text        NOT NULL CHECK (char_length(emoji) <= 8),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id)
);

ALTER TABLE message_reactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_reactions" ON message_reactions FOR SELECT
  TO authenticated USING (
    EXISTS (
      SELECT 1 FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = message_reactions.message_id
        AND (c.user1_id = auth.uid() OR c.user2_id = auth.uid())
    )
  );
CREATE POLICY "insert_own_reaction" ON message_reactions FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "update_own_reaction" ON message_reactions FOR UPDATE
  TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "delete_own_reaction" ON message_reactions FOR DELETE
  TO authenticated USING (auth.uid() = user_id);

-- 6. Screenshot events (architecture only)
CREATE TABLE IF NOT EXISTS screenshot_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE screenshot_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_screenshot_events" ON screenshot_events FOR SELECT
  TO authenticated USING (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = screenshot_events.conversation_id
        AND (c.user1_id = auth.uid() OR c.user2_id = auth.uid())
    )
  );
CREATE POLICY "insert_screenshot_event" ON screenshot_events FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);

-- 7. View-once tracking
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS view_once     bool        NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS viewed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS reply_to      uuid        REFERENCES messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deleted_for_all bool      NOT NULL DEFAULT false;

-- Remove duplicate reply_to if it already exists (idempotent)
DO $$
BEGIN
  -- reply_to was already added in a previous migration, skip if duplicate
  NULL;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- 8. Enable realtime on new tables
ALTER PUBLICATION supabase_realtime ADD TABLE message_reactions;
ALTER PUBLICATION supabase_realtime ADD TABLE message_deletions;
ALTER PUBLICATION supabase_realtime ADD TABLE private_notes;

-- 9. server-side purge helper: delete expired messages
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

-- 10. Helper: mark message as viewed (view-once)
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
