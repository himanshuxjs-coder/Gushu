
-- Extensions
CREATE EXTENSION IF NOT EXISTS citext;

-- Roles
CREATE TYPE public.app_role AS ENUM ('admin', 'user');

CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users see own roles" ON public.user_roles FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;

-- Profiles
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username CITEXT NOT NULL UNIQUE,
  display_name TEXT,
  avatar_url TEXT,
  bio TEXT,
  verified BOOLEAN NOT NULL DEFAULT false,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT username_format CHECK (username ~ '^[a-z0-9_]{3,20}$')
);
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles readable by authenticated" ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "users update own profile" ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid() AND verified = (SELECT verified FROM public.profiles WHERE id = auth.uid()));
CREATE POLICY "admins update any profile" ON public.profiles FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.tg_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
CREATE TRIGGER profiles_set_updated_at BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_username TEXT;
BEGIN
  v_username := lower(coalesce(NEW.raw_user_meta_data->>'username', split_part(NEW.email, '@', 1)));
  v_username := regexp_replace(v_username, '[^a-z0-9_]', '_', 'g');
  IF length(v_username) < 3 THEN v_username := v_username || '_user'; END IF;
  IF length(v_username) > 20 THEN v_username := substr(v_username, 1, 20); END IF;
  -- ensure uniqueness
  WHILE EXISTS (SELECT 1 FROM public.profiles WHERE username = v_username) LOOP
    v_username := substr(v_username, 1, 15) || '_' || substr(md5(random()::text), 1, 4);
  END LOOP;
  INSERT INTO public.profiles (id, username, display_name)
  VALUES (NEW.id, v_username, coalesce(NEW.raw_user_meta_data->>'display_name', v_username));
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'user');
  RETURN NEW;
END $$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Conversations (1:1)
CREATE TABLE public.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user1_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user2_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT distinct_users CHECK (user1_id <> user2_id),
  CONSTRAINT ordered_users CHECK (user1_id < user2_id),
  UNIQUE (user1_id, user2_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversations TO authenticated;
GRANT ALL ON public.conversations TO service_role;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "participants read conversation" ON public.conversations FOR SELECT TO authenticated
  USING (auth.uid() IN (user1_id, user2_id));
CREATE POLICY "users create own conversation" ON public.conversations FOR INSERT TO authenticated
  WITH CHECK (auth.uid() IN (user1_id, user2_id));
CREATE POLICY "participants update conversation" ON public.conversations FOR UPDATE TO authenticated
  USING (auth.uid() IN (user1_id, user2_id))
  WITH CHECK (auth.uid() IN (user1_id, user2_id));

CREATE INDEX conversations_user1_idx ON public.conversations(user1_id);
CREATE INDEX conversations_user2_idx ON public.conversations(user2_id);

-- Helper to find or create a conversation between two users
CREATE OR REPLACE FUNCTION public.get_or_create_conversation(_other_user UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_u1 UUID;
  v_u2 UUID;
  v_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF _other_user = auth.uid() THEN RAISE EXCEPTION 'cannot start a conversation with yourself'; END IF;
  IF auth.uid() < _other_user THEN v_u1 := auth.uid(); v_u2 := _other_user;
  ELSE v_u1 := _other_user; v_u2 := auth.uid(); END IF;
  SELECT id INTO v_id FROM public.conversations WHERE user1_id = v_u1 AND user2_id = v_u2;
  IF v_id IS NULL THEN
    INSERT INTO public.conversations (user1_id, user2_id) VALUES (v_u1, v_u2) RETURNING id INTO v_id;
    INSERT INTO public.conversation_status (conversation_id, user_id, has_left)
      VALUES (v_id, v_u1, false), (v_id, v_u2, false);
  ELSE
    -- if either user previously left, reset
    UPDATE public.conversation_status SET has_left = false, left_at = NULL
      WHERE conversation_id = v_id AND user_id = auth.uid();
  END IF;
  RETURN v_id;
END $$;

-- Messages
CREATE TYPE public.message_kind AS ENUM ('text', 'image', 'video', 'file');

CREATE TABLE public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT,
  media_path TEXT,
  media_mime TEXT,
  media_name TEXT,
  media_size BIGINT,
  message_type public.message_kind NOT NULL DEFAULT 'text',
  edited BOOLEAN NOT NULL DEFAULT false,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.messages TO authenticated;
GRANT ALL ON public.messages TO service_role;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_conversation_participant(_conv UUID, _user UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.conversations WHERE id = _conv AND _user IN (user1_id, user2_id))
$$;

CREATE POLICY "participants read messages" ON public.messages FOR SELECT TO authenticated
  USING (public.is_conversation_participant(conversation_id, auth.uid()));
CREATE POLICY "participants send messages" ON public.messages FOR INSERT TO authenticated
  WITH CHECK (sender_id = auth.uid() AND public.is_conversation_participant(conversation_id, auth.uid()));
CREATE POLICY "senders edit own messages" ON public.messages FOR UPDATE TO authenticated
  USING (sender_id = auth.uid())
  WITH CHECK (sender_id = auth.uid());
CREATE POLICY "recipients mark read" ON public.messages FOR UPDATE TO authenticated
  USING (sender_id <> auth.uid() AND public.is_conversation_participant(conversation_id, auth.uid()))
  WITH CHECK (sender_id <> auth.uid() AND public.is_conversation_participant(conversation_id, auth.uid()));

CREATE INDEX messages_conv_created_idx ON public.messages(conversation_id, created_at DESC);
CREATE INDEX messages_sender_idx ON public.messages(sender_id);
CREATE INDEX messages_unread_idx ON public.messages(conversation_id, sender_id) WHERE read_at IS NULL;

CREATE TRIGGER messages_set_updated_at BEFORE UPDATE ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- Bump conversation last_message_at on new message
CREATE OR REPLACE FUNCTION public.tg_bump_conversation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.conversations SET last_message_at = NEW.created_at WHERE id = NEW.conversation_id;
  RETURN NEW;
END $$;
CREATE TRIGGER messages_bump_conv AFTER INSERT ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.tg_bump_conversation();

-- conversation_status
CREATE TABLE public.conversation_status (
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  has_left BOOLEAN NOT NULL DEFAULT false,
  left_at TIMESTAMPTZ,
  PRIMARY KEY (conversation_id, user_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversation_status TO authenticated;
GRANT ALL ON public.conversation_status TO service_role;
ALTER TABLE public.conversation_status ENABLE ROW LEVEL SECURITY;
CREATE POLICY "participants read status" ON public.conversation_status FOR SELECT TO authenticated
  USING (public.is_conversation_participant(conversation_id, auth.uid()));
CREATE POLICY "self update status" ON public.conversation_status FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE INDEX conv_status_user_idx ON public.conversation_status(user_id);

-- Purge conversation when both have left
CREATE OR REPLACE FUNCTION public.purge_conversation(_conv UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.messages WHERE conversation_id = _conv;
  DELETE FROM public.conversation_status WHERE conversation_id = _conv;
  DELETE FROM public.conversations WHERE id = _conv;
END $$;

CREATE OR REPLACE FUNCTION public.leave_conversation(_conv UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_both_left BOOLEAN;
BEGIN
  IF NOT public.is_conversation_participant(_conv, auth.uid()) THEN
    RAISE EXCEPTION 'not a participant';
  END IF;
  UPDATE public.conversation_status SET has_left = true, left_at = now()
    WHERE conversation_id = _conv AND user_id = auth.uid();
  SELECT bool_and(has_left) INTO v_both_left FROM public.conversation_status WHERE conversation_id = _conv;
  IF v_both_left THEN
    PERFORM public.purge_conversation(_conv);
    RETURN true;
  END IF;
  RETURN false;
END $$;

-- Storage RLS: avatars (user-id folder)
CREATE POLICY "avatars readable by authenticated" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'avatars');
CREATE POLICY "avatars upload own folder" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "avatars update own folder" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "avatars delete own folder" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Storage RLS: chat-media (conversation folder, participants only)
CREATE POLICY "chat-media participants read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'chat-media' AND public.is_conversation_participant(((storage.foldername(name))[1])::uuid, auth.uid()));
CREATE POLICY "chat-media participants insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'chat-media' AND public.is_conversation_participant(((storage.foldername(name))[1])::uuid, auth.uid()));
CREATE POLICY "chat-media participants delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'chat-media' AND public.is_conversation_participant(((storage.foldername(name))[1])::uuid, auth.uid()));

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE public.conversation_status;
ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles;

ALTER TABLE public.messages REPLICA IDENTITY FULL;
ALTER TABLE public.conversations REPLICA IDENTITY FULL;
ALTER TABLE public.conversation_status REPLICA IDENTITY FULL;
ALTER TABLE public.profiles REPLICA IDENTITY FULL;
