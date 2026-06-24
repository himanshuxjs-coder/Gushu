-- ============================================================
-- CRITICAL PERSISTENCE & PRIVACY SYSTEM FIX
-- ============================================================

-- 1. Ensure conversation_settings has all required columns with proper defaults
ALTER TABLE public.conversation_settings
  ADD COLUMN IF NOT EXISTS notification_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS secret_code_hash TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS disappear_after_view_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Ensure existing rows have updated_at
UPDATE public.conversation_settings SET updated_at = now() WHERE updated_at IS NULL;

-- 2. Create trigger to auto-update updated_at on conversation_settings
CREATE OR REPLACE FUNCTION public.tg_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS conversation_settings_set_updated_at ON public.conversation_settings;
CREATE TRIGGER conversation_settings_set_updated_at
  BEFORE UPDATE ON public.conversation_settings
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- 3. Fix leave_conversation: do NOT delete conversation_settings when user leaves
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

-- 4. Fix purge_conversation: preserve conversation_settings for potential rejoin
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

-- 5. Create a function to get conversation settings with defaults
CREATE OR REPLACE FUNCTION public.get_conversation_settings_with_defaults(_conv UUID, _user UUID)
RETURNS TABLE (
  conversation_id UUID,
  user_id UUID,
  pin_hash TEXT,
  is_locked BOOLEAN,
  is_hidden BOOLEAN,
  expiry_seconds INT,
  theme TEXT,
  wallpaper_url TEXT,
  cleared_at TIMESTAMPTZ,
  notification_enabled BOOLEAN,
  secret_code_hash TEXT,
  disappear_after_view_enabled BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.conversation_settings (
    conversation_id, user_id, theme, is_locked, is_hidden,
    notification_enabled, disappear_after_view_enabled
  )
  VALUES (
    _conv, _user, 'obsidian', false, false,
    false, false
  )
  ON CONFLICT (conversation_id, user_id) DO NOTHING;

  RETURN QUERY
  SELECT
    cs.conversation_id,
    cs.user_id,
    cs.pin_hash,
    cs.is_locked,
    cs.is_hidden,
    cs.expiry_seconds,
    cs.theme,
    cs.wallpaper_url,
    cs.cleared_at,
    cs.notification_enabled,
    cs.secret_code_hash,
    cs.disappear_after_view_enabled,
    cs.created_at,
    cs.updated_at
  FROM public.conversation_settings cs
  WHERE cs.conversation_id = _conv AND cs.user_id = _user;
END $$;

-- 6. Fix listMyConversations to properly filter hidden chats
CREATE OR REPLACE FUNCTION public.list_my_conversations()
RETURNS TABLE (
  id UUID,
  other JSONB,
  last JSONB,
  unread BIGINT,
  last_message_at TIMESTAMPTZ,
  hidden BOOLEAN,
  locked BOOLEAN,
  has_pin BOOLEAN,
  cleared_at TIMESTAMPTZ
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  RETURN QUERY
  WITH my_convs AS (
    SELECT c.id, c.user1_id, c.user2_id, c.last_message_at
    FROM public.conversations c
    JOIN public.conversation_status cs ON cs.conversation_id = c.id
    WHERE cs.user_id = v_user_id AND cs.has_left = false
  ),
  settings AS (
    SELECT cs.conversation_id, cs.is_hidden, cs.is_locked, cs.pin_hash IS NOT NULL as has_pin, cs.cleared_at
    FROM public.conversation_settings cs
    WHERE cs.user_id = v_user_id
  ),
  last_msgs AS (
    SELECT DISTINCT ON (m.conversation_id)
      m.conversation_id, m.content, m.message_type, m.created_at, m.sender_id
    FROM public.messages m
    WHERE m.conversation_id IN (SELECT id FROM my_convs)
    ORDER BY m.conversation_id, m.created_at DESC
  ),
  unread_counts AS (
    SELECT m.conversation_id, COUNT(*) as cnt
    FROM public.messages m
    WHERE m.conversation_id IN (SELECT id FROM my_convs)
      AND m.read_at IS NULL AND m.sender_id <> v_user_id
    GROUP BY m.conversation_id
  )
  SELECT
    mc.id,
    jsonb_build_object(
      'id', CASE WHEN mc.user1_id = v_user_id THEN mc.user2_id ELSE mc.user1_id END,
      'username', p.username,
      'display_name', p.display_name,
      'avatar_url', p.avatar_url,
      'verified', p.verified,
      'last_seen_at', p.last_seen_at
    ) as other,
    CASE WHEN lm.conversation_id IS NOT NULL THEN
      jsonb_build_object(
        'content', lm.content,
        'message_type', lm.message_type,
        'created_at', lm.created_at,
        'sender_id', lm.sender_id
      )
    ELSE NULL END as last,
    COALESCE(uc.cnt, 0)::bigint as unread,
    mc.last_message_at,
    COALESCE(s.is_hidden, false) as hidden,
    COALESCE(s.is_locked, false) as locked,
    COALESCE(s.has_pin, false) as has_pin,
    s.cleared_at
  FROM my_convs mc
  LEFT JOIN settings s ON s.conversation_id = mc.id
  LEFT JOIN last_msgs lm ON lm.conversation_id = mc.id
  LEFT JOIN unread_counts uc ON uc.conversation_id = mc.id
  LEFT JOIN profiles p ON p.id = CASE WHEN mc.user1_id = v_user_id THEN mc.user2_id ELSE mc.user1_id END
  WHERE COALESCE(s.is_hidden, false) = false;
END $$;

-- 7. Create function to find hidden chat by secret code
CREATE OR REPLACE FUNCTION public.find_hidden_chat_by_code(_code TEXT)
RETURNS TABLE (conversation_id UUID, found BOOLEAN) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id UUID := auth.uid();
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT cs.conversation_id, cs.secret_code_hash
    FROM public.conversation_settings cs
    WHERE cs.user_id = v_user_id
      AND cs.is_hidden = true
      AND cs.secret_code_hash IS NOT NULL
  LOOP
    IF crypt(_code, rec.secret_code_hash) = rec.secret_code_hash THEN
      RETURN QUERY SELECT rec.conversation_id, true;
      RETURN;
    END IF;
  END LOOP;
  RETURN QUERY SELECT NULL::UUID, false;
END $$;

-- 8. Ensure pgcrypto extension is available for crypt()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 9. Fix mark_message_viewed: only apply view limits to media (image, video, file)
CREATE OR REPLACE FUNCTION public.mark_message_viewed(_msg_id UUID, _viewer_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  msg_rec RECORD;
  new_view_count INTEGER;
BEGIN
  SELECT * INTO msg_rec FROM public.messages WHERE id = _msg_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF msg_rec.message_type IN ('image', 'video', 'file') THEN
    UPDATE public.messages
    SET view_count = view_count + 1,
        viewed_at = COALESCE(viewed_at, NOW())
    WHERE id = _msg_id
    RETURNING view_count INTO new_view_count;
  ELSE
    UPDATE public.messages
    SET viewed_at = COALESCE(viewed_at, NOW())
    WHERE id = _msg_id;
    new_view_count := msg_rec.view_count;
  END IF;

  IF msg_rec.disappear_after_view AND msg_rec.sender_id != _viewer_id THEN
    DELETE FROM public.message_reactions WHERE message_id = _msg_id;
    DELETE FROM public.message_deletions WHERE message_id = _msg_id;
    DELETE FROM public.messages WHERE id = _msg_id;
    RETURN;
  END IF;

  IF msg_rec.message_type IN ('image', 'video', 'file')
     AND msg_rec.view_limit IS NOT NULL
     AND msg_rec.sender_id != _viewer_id THEN
    IF new_view_count >= msg_rec.view_limit THEN
      DELETE FROM public.message_reactions WHERE message_id = _msg_id;
      DELETE FROM public.message_deletions WHERE message_id = _msg_id;
      DELETE FROM public.messages WHERE id = _msg_id;
    END IF;
  END IF;
END $$;

-- 10. Create function to verify conversation PIN server-side
CREATE OR REPLACE FUNCTION public.verify_conversation_pin(_conv UUID, _pin TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_hash TEXT;
BEGIN
  SELECT pin_hash INTO v_hash
  FROM public.conversation_settings
  WHERE conversation_id = _conv AND user_id = auth.uid();

  IF v_hash IS NULL THEN RETURN false; END IF;
  RETURN crypt(_pin, v_hash) = v_hash;
END $$;

-- 11. Create function to check if conversation is locked
CREATE OR REPLACE FUNCTION public.is_conversation_locked(_conv UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_locked BOOLEAN;
  v_has_pin BOOLEAN;
BEGIN
  SELECT is_locked, pin_hash IS NOT NULL
  INTO v_locked, v_has_pin
  FROM public.conversation_settings
  WHERE conversation_id = _conv AND user_id = auth.uid();

  RETURN COALESCE(v_locked, false) AND COALESCE(v_has_pin, false);
END $$;

-- 12. Grant execute on new functions
GRANT EXECUTE ON FUNCTION public.get_conversation_settings_with_defaults(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.find_hidden_chat_by_code(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_conversation_pin(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_conversation_locked(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_my_conversations() TO authenticated;

-- 13. Add conversation_settings to realtime
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_rel pr
    JOIN pg_class c ON pr.prrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    JOIN pg_publication p ON pr.prpubid = p.oid
    WHERE p.pubname = 'supabase_realtime' AND n.nspname = 'public' AND c.relname = 'conversation_settings'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.conversation_settings';
  END IF;
END
$$;

ALTER TABLE public.conversation_settings REPLICA IDENTITY FULL;

-- 14. Add index for faster settings lookups
CREATE INDEX IF NOT EXISTS idx_conversation_settings_lookup
ON public.conversation_settings(conversation_id, user_id);
