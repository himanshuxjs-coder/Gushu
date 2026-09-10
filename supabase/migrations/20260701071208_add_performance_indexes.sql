-- Add performance indexes for messages table
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_sender ON messages(conversation_id, sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_expires_at ON messages(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_disappear_after_view ON messages(conversation_id, disappear_after_view) WHERE disappear_after_view = true;

-- Add index for message_deletions lookups
CREATE INDEX IF NOT EXISTS idx_message_deletions_user ON message_deletions(user_id, message_id);

-- Add index for conversation_settings
CREATE INDEX IF NOT EXISTS idx_conversation_settings_user ON conversation_settings(user_id);
CREATE INDEX IF NOT EXISTS idx_conversation_settings_conversation ON conversation_settings(conversation_id);

-- Add index for active_conversations for presence tracking
CREATE INDEX IF NOT EXISTS idx_active_conversations_user_updated ON active_conversations(user_id, updated_at DESC);

-- Add index for typing_status
CREATE INDEX IF NOT EXISTS idx_typing_status_conversation ON typing_status(conversation_id, typing_at DESC);

-- Add index for message_reactions
CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions(message_id);

-- Add index for message_saves
CREATE INDEX IF NOT EXISTS idx_message_saves_user ON message_saves(user_id);
CREATE INDEX IF NOT EXISTS idx_message_saves_message ON message_saves(message_id);

-- Add index for message_user_views
CREATE INDEX IF NOT EXISTS idx_message_user_views_message_user ON message_user_views(message_id, user_id);