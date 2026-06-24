-- Per-user message visibility: hide messages from users who have left
-- This implements privacy-first conversation semantics

-- Helper function: check if user is an active participant (hasn't left)
CREATE OR REPLACE FUNCTION public.is_active_conversation_participant(_conv UUID, _user UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.conversations c
    JOIN public.conversation_status cs ON cs.conversation_id = c.id
    WHERE c.id = _conv 
      AND _user IN (c.user1_id, c.user2_id)
      AND cs.user_id = _user
      AND cs.has_left = false
  )
$$;

-- Drop old message policies
DROP POLICY IF EXISTS "participants read messages" ON public.messages;
DROP POLICY IF EXISTS "participants send messages" ON public.messages;
DROP POLICY IF EXISTS "senders edit own messages" ON public.messages;
DROP POLICY IF EXISTS "recipients mark read" ON public.messages;

-- New message policies: only active participants can access messages
CREATE POLICY "active_participants read messages" ON public.messages FOR SELECT TO authenticated
  USING (public.is_active_conversation_participant(conversation_id, auth.uid()));

CREATE POLICY "active_participants send messages" ON public.messages FOR INSERT TO authenticated
  WITH CHECK (sender_id = auth.uid() AND public.is_active_conversation_participant(conversation_id, auth.uid()));

CREATE POLICY "active_senders edit own messages" ON public.messages FOR UPDATE TO authenticated
  USING (sender_id = auth.uid() AND public.is_active_conversation_participant(conversation_id, auth.uid()))
  WITH CHECK (sender_id = auth.uid() AND public.is_active_conversation_participant(conversation_id, auth.uid()));

CREATE POLICY "active_recipients mark read" ON public.messages FOR UPDATE TO authenticated
  USING (sender_id <> auth.uid() AND public.is_active_conversation_participant(conversation_id, auth.uid()))
  WITH CHECK (sender_id <> auth.uid() AND public.is_active_conversation_participant(conversation_id, auth.uid()));

-- Update storage RLS for chat-media
DROP POLICY IF EXISTS "chat-media participants read" ON storage.objects;
DROP POLICY IF EXISTS "chat-media participants insert" ON storage.objects;
DROP POLICY IF EXISTS "chat-media participants delete" ON storage.objects;

CREATE POLICY "chat-media active_participants read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'chat-media' AND public.is_active_conversation_participant(((storage.foldername(name))[1])::uuid, auth.uid()));

CREATE POLICY "chat-media active_participants insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'chat-media' AND public.is_active_conversation_participant(((storage.foldername(name))[1])::uuid, auth.uid()));

CREATE POLICY "chat-media active_participants delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'chat-media' AND public.is_active_conversation_participant(((storage.foldername(name))[1])::uuid, auth.uid()));

-- Helper function for conversation visibility
CREATE OR REPLACE FUNCTION public.user_can_see_conversation(_conv UUID, _user UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.conversations c
    JOIN public.conversation_status cs ON cs.conversation_id = c.id
    WHERE c.id = _conv 
      AND _user IN (c.user1_id, c.user2_id)
      AND cs.user_id = _user
      AND cs.has_left = false
  )
$$;

-- Update conversation RLS: users who left can't see conversation
DROP POLICY IF EXISTS "participants read conversation" ON public.conversations;
DROP POLICY IF EXISTS "users create own conversation" ON public.conversations;
DROP POLICY IF EXISTS "participants update conversation" ON public.conversations;

CREATE POLICY "active_participants read conversation" ON public.conversations FOR SELECT TO authenticated
  USING (public.user_can_see_conversation(id, auth.uid()));

CREATE POLICY "users create own conversation" ON public.conversations FOR INSERT TO authenticated
  WITH CHECK (auth.uid() IN (user1_id, user2_id));

CREATE POLICY "participants update conversation" ON public.conversations FOR UPDATE TO authenticated
  USING (auth.uid() IN (user1_id, user2_id))
  WITH CHECK (auth.uid() IN (user1_id, user2_id));

-- Update get_or_create_conversation: DON'T reset has_left when rejoining
-- If user had left, start a NEW conversation (fresh, no history reuse)
CREATE OR REPLACE FUNCTION public.get_or_create_conversation(_other_user UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_u1 UUID;
  v_u2 UUID;
  v_id UUID;
  v_my_left BOOLEAN;
  v_other_left BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF _other_user = auth.uid() THEN RAISE EXCEPTION 'cannot start a conversation with yourself'; END IF;
  
  -- Order users consistently
  IF auth.uid() < _other_user THEN 
    v_u1 := auth.uid(); v_u2 := _other_user;
  ELSE 
    v_u1 := _other_user; v_u2 := auth.uid();
  END IF;
  
  -- Check for existing conversation
  SELECT id INTO v_id FROM public.conversations WHERE user1_id = v_u1 AND user2_id = v_u2;
  
  IF v_id IS NOT NULL THEN
    -- Check if current user has left this conversation
    SELECT has_left INTO v_my_left FROM public.conversation_status
      WHERE conversation_id = v_id AND user_id = auth.uid();
    
    -- If user has left, CREATE A NEW CONVERSATION instead of reusing
    IF v_my_left THEN
      -- Check if other user also left
      SELECT has_left INTO v_other_left FROM public.conversation_status
        WHERE conversation_id = v_id AND user_id = _other_user;
      
      -- If both left, purge the old conversation first
      IF v_other_left THEN
        PERFORM public.purge_conversation(v_id);
      END IF;
      
      -- Create brand new conversation (fresh start, no history)
      INSERT INTO public.conversations (user1_id, user2_id) 
        VALUES (v_u1, v_u2) RETURNING id INTO v_id;
      INSERT INTO public.conversation_status (conversation_id, user_id, has_left)
        VALUES (v_id, v_u1, false), (v_id, v_u2, false);
      
      RETURN v_id;
    END IF;
    
    -- User hasn't left - return existing conversation
    RETURN v_id;
  END IF;
  
  -- No existing conversation, create new
  INSERT INTO public.conversations (user1_id, user2_id) VALUES (v_u1, v_u2) RETURNING id INTO v_id;
  INSERT INTO public.conversation_status (conversation_id, user_id, has_left)
    VALUES (v_id, v_u1, false), (v_id, v_u2, false);
  
  RETURN v_id;
END $$;
