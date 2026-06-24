-- Add 'audio' to the message_kind enum to support voice notes
ALTER TYPE message_kind ADD VALUE IF NOT EXISTS 'audio';
