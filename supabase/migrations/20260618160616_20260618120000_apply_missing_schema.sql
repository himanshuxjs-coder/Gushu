-- Apply missing schema pieces for the Gushu app

-- 1. Add 'audio' to message_kind enum
ALTER TYPE public.message_kind ADD VALUE IF NOT EXISTS 'audio';

-- 2. Add typing_at to profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS typing_at TIMESTAMPTZ;

-- 3. Create typing_status table
CREATE TABLE IF NOT EXISTS public.typing_status (
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  typing_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.typing_status TO authenticated;
GRANT ALL ON public.typing_status TO service_role;

ALTER TABLE public.typing_status ENABLE ROW LEVEL SECURITY;

-- Drop and recreate typing_status policies
DROP POLICY IF EXISTS "participants read typing status" ON public.typing_status;
DROP POLICY IF EXISTS "users update own typing status" ON public.typing_status;
DROP POLICY IF EXISTS "users update own typing status on update" ON public.typing_status;
DROP POLICY IF EXISTS "users delete own typing status" ON public.typing_status;

CREATE POLICY "participants read typing status" ON public.typing_status FOR SELECT TO authenticated
  USING (public.is_conversation_participant(conversation_id, auth.uid()));

CREATE POLICY "users update own typing status" ON public.typing_status FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.is_conversation_participant(conversation_id, auth.uid()));

CREATE POLICY "users update own typing status on update" ON public.typing_status FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND public.is_conversation_participant(conversation_id, auth.uid()))
  WITH CHECK (user_id = auth.uid() AND public.is_conversation_participant(conversation_id, auth.uid()));

CREATE POLICY "users delete own typing status" ON public.typing_status FOR DELETE TO authenticated
  USING (user_id = auth.uid() AND public.is_conversation_participant(conversation_id, auth.uid()));

CREATE INDEX IF NOT EXISTS typing_status_user_idx ON public.typing_status(user_id);
CREATE INDEX IF NOT EXISTS typing_status_conv_idx ON public.typing_status(conversation_id);

-- 4. Create active participant check functions
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

-- 5. Update messages RLS policies to use active participant check
DROP POLICY IF EXISTS "participants read messages" ON public.messages;
DROP POLICY IF EXISTS "participants send messages" ON public.messages;
DROP POLICY IF EXISTS "senders edit own messages" ON public.messages;
DROP POLICY IF EXISTS "recipients mark read" ON public.messages;
DROP POLICY IF EXISTS "active_participants read messages" ON public.messages;
DROP POLICY IF EXISTS "active_participants send messages" ON public.messages;
DROP POLICY IF EXISTS "active_senders edit own messages" ON public.messages;
DROP POLICY IF EXISTS "active_recipients mark read" ON public.messages;

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

-- 6. Update conversation RLS to use user_can_see_conversation
DROP POLICY IF EXISTS "participants read conversation" ON public.conversations;
DROP POLICY IF EXISTS "active_participants read conversation" ON public.conversations;

CREATE POLICY "active_participants read conversation" ON public.conversations FOR SELECT TO authenticated
  USING (public.user_can_see_conversation(id, auth.uid()));

-- 7. Update get_or_create_conversation: privacy-first, don't reset when rejoining
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

  IF auth.uid() < _other_user THEN
    v_u1 := auth.uid(); v_u2 := _other_user;
  ELSE
    v_u1 := _other_user; v_u2 := auth.uid();
  END IF;

  SELECT id INTO v_id FROM public.conversations WHERE user1_id = v_u1 AND user2_id = v_u2;

  IF v_id IS NOT NULL THEN
    SELECT has_left INTO v_my_left FROM public.conversation_status
      WHERE conversation_id = v_id AND user_id = auth.uid();

    IF v_my_left THEN
      SELECT has_left INTO v_other_left FROM public.conversation_status
        WHERE conversation_id = v_id AND user_id = _other_user;

      IF v_other_left THEN
        PERFORM public.purge_conversation(v_id);
      END IF;

      INSERT INTO public.conversations (user1_id, user2_id)
        VALUES (v_u1, v_u2) RETURNING id INTO v_id;
      INSERT INTO public.conversation_status (conversation_id, user_id, has_left)
        VALUES (v_id, v_u1, false), (v_id, v_u2, false);

      RETURN v_id;
    END IF;

    RETURN v_id;
  END IF;

  INSERT INTO public.conversations (user1_id, user2_id) VALUES (v_u1, v_u2) RETURNING id INTO v_id;
  INSERT INTO public.conversation_status (conversation_id, user_id, has_left)
    VALUES (v_id, v_u1, false), (v_id, v_u2, false);

  RETURN v_id;
END $$;

-- 8. Update chat-media storage RLS policies
DROP POLICY IF EXISTS "chat-media participants read" ON storage.objects;
DROP POLICY IF EXISTS "chat-media participants insert" ON storage.objects;
DROP POLICY IF EXISTS "chat-media participants delete" ON storage.objects;
DROP POLICY IF EXISTS "chat-media active_participants read" ON storage.objects;
DROP POLICY IF EXISTS "chat-media active_participants insert" ON storage.objects;
DROP POLICY IF EXISTS "chat-media active_participants delete" ON storage.objects;

CREATE POLICY "chat-media active_participants read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'chat-media' AND public.is_active_conversation_participant(((storage.foldername(name))[1])::uuid, auth.uid()));

CREATE POLICY "chat-media active_participants insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'chat-media' AND public.is_active_conversation_participant(((storage.foldername(name))[1])::uuid, auth.uid()));

CREATE POLICY "chat-media active_participants delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'chat-media' AND public.is_active_conversation_participant(((storage.foldername(name))[1])::uuid, auth.uid()));

-- 9. Add missing indexes
CREATE INDEX IF NOT EXISTS messages_sender_idx ON public.messages(sender_id);
CREATE INDEX IF NOT EXISTS messages_unread_idx ON public.messages(conversation_id, sender_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS messages_reply_to_idx ON public.messages(reply_to);

-- 10. Add typing_status to realtime
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_rel pr
    JOIN pg_class c ON pr.prrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    JOIN pg_publication p ON pr.prpubid = p.oid
    WHERE p.pubname = 'supabase_realtime' AND n.nspname = 'public' AND c.relname = 'typing_status'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.typing_status';
  END IF;
END
$$;

ALTER TABLE public.typing_status REPLICA IDENTITY FULL;

-- 11. Revoke execute on security functions from public/anon
REVOKE EXECUTE ON FUNCTION public.is_active_conversation_participant(UUID, UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.user_can_see_conversation(UUID, UUID) FROM PUBLIC, anon;
