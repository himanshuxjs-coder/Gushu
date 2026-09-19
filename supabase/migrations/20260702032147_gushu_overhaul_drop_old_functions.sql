/*
# Gushu Production Overhaul Part 1 — Drop functions that change signature

Drops functions that need a signature change so they can be recreated in the
next migration. Uses CASCADE for tg_set_message_expiry because a trigger
depends on it (the trigger is recreated in part 2). No user data is lost.
*/

DROP FUNCTION IF EXISTS public.purge_expired_messages() CASCADE;
DROP FUNCTION IF EXISTS public.cleanup_cleared_messages(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.commit_view_once_expiration(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.mark_message_viewed(uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.mark_conversation_read(uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.save_message(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.unsave_message(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.tg_set_message_expiry() CASCADE;
