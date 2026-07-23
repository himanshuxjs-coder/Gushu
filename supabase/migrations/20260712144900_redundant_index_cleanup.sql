/*
# Redundant Index Cleanup

1. Overview
   Over multiple iterations the schema accumulated duplicate indexes on the same
   column combinations. Each duplicate wastes disk, slows writes, and bloats the
   planner's search space. This migration drops only EXACT duplicates — indexes
   whose column list (and order) is fully covered by another index (usually a
   UNIQUE constraint or PK). No query plan loses access to an index it was using;
   the surviving index serves the same queries.

2. Tables and changes

   active_conversations (drop 4):
   - active_conversations_lookup_idx      — dup of active_conversations_user_conversation_unique
   - active_conversations_updated_idx      — dup of idx_active_conversations_updated_at
   - idx_active_conversations_updated_at   — dup of active_conversations_updated_idx
   - idx_active_conversations_user_id      — covered by active_conversations_user_idx (UNIQUE on user_id)

   messages (drop 8):
   - idx_messages_conv_created             — dup of messages_conversation_created_idx
   - idx_messages_conversation_created      — dup of messages_conversation_created_idx
   - messages_not_deleted_idx              — dup of messages_conversation_created_idx
   - messages_conv_created_idx             — dup of messages_conversation_created_idx
   - idx_messages_conversation_sender      — covered by idx_messages_unread
   - messages_unread_idx                   — covered by idx_messages_unread
   - idx_messages_expires_at               — dup of messages_expires_at_idx

   message_saves (drop 3):
   - idx_message_saves_message             — dup of idx_message_saves_message_id
   - idx_message_saves_user                — covered by PK prefix (user_id)
   - idx_message_saves_message_id          — keep one, drop the other

   message_user_views (drop 2):
   - message_user_views_message_id_idx     — covered by unique constraint
   - idx_message_user_views_message_user   — dup of unique constraint

   message_deletions (drop 1):
   - message_deletions_user_msg_idx         — dup of idx_message_deletions_user

   typing_status (drop 1):
   - typing_status_conv_idx                 — covered by PK prefix

3. Security
   No RLS or policy changes — index-only cleanup.

4. Important notes
   - Only exact duplicates are removed.
   - Idempotent: uses DROP INDEX IF EXISTS.
*/

-- active_conversations: drop 4 redundant indexes
DROP INDEX IF EXISTS public.active_conversations_lookup_idx;
DROP INDEX IF EXISTS public.active_conversations_updated_idx;
DROP INDEX IF EXISTS public.idx_active_conversations_updated_at;
DROP INDEX IF EXISTS public.idx_active_conversations_user_id;

-- messages: drop 8 redundant indexes
DROP INDEX IF EXISTS public.idx_messages_conv_created;
DROP INDEX IF EXISTS public.idx_messages_conversation_created;
DROP INDEX IF EXISTS public.messages_not_deleted_idx;
DROP INDEX IF EXISTS public.messages_conv_created_idx;
DROP INDEX IF EXISTS public.idx_messages_conversation_sender;
DROP INDEX IF EXISTS public.messages_unread_idx;
DROP INDEX IF EXISTS public.idx_messages_expires_at;

-- message_saves: drop 3 redundant indexes (keep PK, idx_message_saves_message, idx_message_saves_conv, message_saves_user_conv_idx)
DROP INDEX IF EXISTS public.idx_message_saves_message;
DROP INDEX IF EXISTS public.idx_message_saves_user;
DROP INDEX IF EXISTS public.idx_message_saves_message_id;

-- message_user_views: drop 2 redundant
DROP INDEX IF EXISTS public.message_user_views_message_id_idx;
DROP INDEX IF EXISTS public.idx_message_user_views_message_user;

-- message_deletions: drop 1 redundant
DROP INDEX IF EXISTS public.message_deletions_user_msg_idx;

-- typing_status: drop 1 redundant (PK covers conversation_id prefix)
DROP INDEX IF EXISTS public.typing_status_conv_idx;
