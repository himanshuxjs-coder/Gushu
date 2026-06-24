-- Add disappear_after_view as conversation-level setting  
ALTER TABLE conversation_settings
ADD COLUMN IF NOT EXISTS disappear_after_view_enabled BOOLEAN DEFAULT FALSE;