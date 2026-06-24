-- Fix view_count to be NOT NULL with default
ALTER TABLE messages ALTER COLUMN view_count SET NOT NULL;

-- Fix disappear_after_view to be NOT NULL with default
ALTER TABLE messages ALTER COLUMN disappear_after_view SET NOT NULL;
