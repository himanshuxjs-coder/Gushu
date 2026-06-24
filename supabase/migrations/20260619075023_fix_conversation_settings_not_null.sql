-- Fix notification_enabled to be NOT NULL with default
ALTER TABLE conversation_settings ALTER COLUMN notification_enabled SET NOT NULL;

-- Fix disappear_after_view_enabled to be NOT NULL with default
ALTER TABLE conversation_settings ALTER COLUMN disappear_after_view_enabled SET NOT NULL;
