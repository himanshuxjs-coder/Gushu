-- ============================================================
-- EMERGENCY STABILITY & BUG FIX AUDIT
-- Fixes duplicate conversations, settings persistence, view limits,
-- message expiration, and all backend issues.
-- ============================================================

-- 1. FIX: get_or_create_conversation race condition
-- The old function had a bug: when a user who previously left tried
-- to rejoin, it would INSERT a new conversation with the same
-- user1_id/user2_id pair, violating the unique constraint.
--
-- Fix: Use advisory lock + proper upsert. If conversation exists
-- and user left, just reset their status. Only create new if truly absent.
CREATE OR REPLACE FUNCTION public.get_or_create_conversation(_other_user UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_u1 UUID;
  v_u2 UUID;
  v_id UUID;
  v_my_left BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF _other_user = auth.uid() THEN RAISE EXCEPTION 'cannot start a conversation with yourself'; END IF;

  -- Enforce ordering for consistent lookup
  IF auth.uid() < _other_user THEN
    v_u1 := auth.uid(); v_u2 := _other_user;
  ELSE
    v_u1 := _other_user; v_u2 := auth.uid();
  END IF;

  -- Use advisory lock based on hash of user pair to prevent race conditions
  PERFORM pg_advisory_lock(hashtext(v_u1::text || ':' || v_u2::text));

  BEGIN
    -- Try to find existing conversation
    SELECT id INTO v_id FROM public.conversations
    WHERE user1_id = v_u1 AND user2_id = v_u2;

    IF v_id IS NOT NULL THEN
      -- Conversation exists. Check if current user left.
      SELECT has_left INTO v_my_left
      FROM public.conversation_status
      WHERE conversation_id = v_id AND user_id = auth.uid();

      IF v_my_left THEN
        -- User previously left — just reset their status. DO NOT create new conversation.
        UPDATE public.conversation_status
        SET has_left = false, left_at = NULL
        WHERE conversation_id = v_id AND user_id = auth.uid();
      END IF;

      -- Return existing conversation ID
      RETURN v_id;
    END IF;

    -- No conversation exists — create new one
    INSERT INTO public.conversations (user1_id, user2_id)
    VALUES (v_u1, v_u2) RETURNING id INTO v_id;

    INSERT INTO public.conversation_status (conversation_id, user_id, has_left)
    VALUES (v_id, v_u1, false), (v_id, v_u2, false);

    RETURN v_id;
  EXCEPTION
    WHEN unique_violation THEN
      -- Race condition: another session created it. Find and return it.
      SELECT id INTO v_id FROM public.conversations
      WHERE user1_id = v_u1 AND user2_id = v_u2;
      RETURN v_id;
  END;
END $$;

-- 2. FIX: list_my_conversations must also check conversation_status.has_left
-- and properly exclude hidden chats
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

-- 3. FIX: mark_message_viewed - properly handle media-only view limits
-- and disappear_after_view
CREATE OR REPLACE FUNCTION public.mark_message_viewed(_msg_id UUID, _viewer_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  msg_rec RECORD;
  new_view_count INTEGER;
BEGIN
  SELECT * INTO msg_rec FROM public.messages WHERE id = _msg_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- Only increment view count for media messages (image, video, file)
  IF msg_rec.message_type IN ('image', 'video', 'file') THEN
    UPDATE public.messages
    SET view_count = view_count + 1,
        viewed_at = COALESCE(viewed_at, NOW())
    WHERE id = _msg_id
    RETURNING view_count INTO new_view_count;
  ELSE
    -- For text/audio, just mark as viewed without incrementing count
    UPDATE public.messages
    SET viewed_at = COALESCE(viewed_at, NOW())
    WHERE id = _msg_id;
    new_view_count := msg_rec.view_count;
  END IF;

  -- If disappear_after_view flag is set and viewer is not sender, delete immediately
  IF msg_rec.disappear_after_view AND msg_rec.sender_id != _viewer_id THEN
    DELETE FROM public.message_reactions WHERE message_id = _msg_id;
    DELETE FROM public.message_deletions WHERE message_id = _msg_id;
    DELETE FROM public.messages WHERE id = _msg_id;
    RETURN;
  END IF;

  -- View limit check: only for media messages, only by recipient
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

-- 4. FIX: purge_conversation should also clean up conversation_settings
-- to prevent orphaned rows
CREATE OR REPLACE FUNCTION public.purge_conversation(_conv UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.message_reactions WHERE message_id IN (
    SELECT id FROM public.messages WHERE conversation_id = _conv
  );
  DELETE FROM public.message_deletions WHERE message_id IN (
    SELECT id FROM public.messages WHERE conversation_id = _conv
  );
  DELETE FROM public.messages WHERE conversation_id = _conv;
  DELETE FROM public.conversation_settings WHERE conversation_id = _conv;
  DELETE FROM public.conversation_status WHERE conversation_id = _conv;
  DELETE FROM public.conversations WHERE id = _conv;
END $$;

-- 5. FIX: leave_conversation - preserve settings when single user leaves
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

-- 6. FIX: Add missing indexes for performance
CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON public.messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON public.messages(conversation_id, sender_id, read_at) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_conversation_status_user_left ON public.conversation_status(user_id, has_left);
CREATE INDEX IF NOT EXISTS idx_conversation_settings_lookup ON public.conversation_settings(conversation_id, user_id);

-- 7. FIX: Ensure conversation_settings has updated_at trigger
CREATE OR REPLACE FUNCTION public.tg_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS conversation_settings_set_updated_at ON public.conversation_settings;
CREATE TRIGGER conversation_settings_set_updated_at
  BEFORE UPDATE ON public.conversation_settings
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- 8. FIX: Add conversation_settings to realtime if not already there
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

-- 9. FIX: Ensure all conversation_settings columns exist with proper defaults
ALTER TABLE public.conversation_settings
  ADD COLUMN IF NOT EXISTS notification_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS secret_code_hash TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS disappear_after_view_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Update any null updated_at values
UPDATE public.conversation_settings SET updated_at = now() WHERE updated_at IS NULL;

-- 10. FIX: Grant execute on all functions
GRANT EXECUTE ON FUNCTION public.get_or_create_conversation(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_my_conversations() TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_message_viewed(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.leave_conversation(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.purge_conversation(UUID) TO authenticated;
