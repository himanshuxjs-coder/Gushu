-- Fix missing RLS policies for message deletion

-- 1. Grant delete permission on messages to the sender
-- Only the sender of a message should be allowed to delete it for everyone
DROP POLICY IF EXISTS "senders delete own messages" ON public.messages;
CREATE POLICY "senders delete own messages" ON public.messages FOR DELETE TO authenticated
  USING (sender_id = auth.uid());

-- 2. Grant update permission on message_deletions to the user
-- This is required for upserting records in the "Delete for me" flow
DROP POLICY IF EXISTS "update_own_deletions" ON public.message_deletions;
CREATE POLICY "update_own_deletions" ON public.message_deletions FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 3. Ensure the delete_own_deletions policy is present (precautionary)
DROP POLICY IF EXISTS "delete_own_deletions" ON public.message_deletions;
CREATE POLICY "delete_own_deletions" ON public.message_deletions FOR DELETE TO authenticated
  USING (auth.uid() = user_id);
