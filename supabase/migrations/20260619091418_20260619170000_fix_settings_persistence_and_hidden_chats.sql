-- ============================================================
-- FIX: Settings persistence, hidden chat security, conversation listing
-- ============================================================

-- 1. FIX: purge_conversation should NOT delete conversation_settings
-- Settings must persist even when both users leave.
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
  -- DO NOT delete conversation_settings - preserve for potential restore
  DELETE FROM public.conversation_status WHERE conversation_id = _conv;
  DELETE FROM public.conversations WHERE id = _conv;
END $$;

-- 2. FIX: get_or_create_conversation must preserve settings when both left
-- Before purging, save settings. After creating new conversation, restore them.
CREATE OR REPLACE FUNCTION public.get_or_create_conversation(_other_user UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_u1 UUID;
  v_u2 UUID;
  v_id UUID;
  v_my_left BOOLEAN;
  v_other_left BOOLEAN;
  v_lock_key BIGINT;
  v_settings RECORD;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF _other_user = auth.uid() THEN RAISE EXCEPTION 'cannot start a conversation with yourself'; END IF;

  IF auth.uid() < _other_user THEN
    v_u1 := auth.uid(); v_u2 := _other_user;
  ELSE
    v_u1 := _other_user; v_u2 := auth.uid();
  END IF;

  v_lock_key := hashtext(v_u1::text || ':' || v_u2::text);
  PERFORM pg_advisory_lock(v_lock_key);

  BEGIN
    SELECT id INTO v_id FROM public.conversations
    WHERE user1_id = v_u1 AND user2_id = v_u2;

    IF v_id IS NOT NULL THEN
      SELECT has_left INTO v_my_left
      FROM public.conversation_status
      WHERE conversation_id = v_id AND user_id = auth.uid();

      IF v_my_left THEN
        SELECT has_left INTO v_other_left
        FROM public.conversation_status
        WHERE conversation_id = v_id AND user_id = _other_user;

        IF v_other_left THEN
          -- Both left: save settings before purge, then restore
          SELECT * INTO v_settings
          FROM public.conversation_settings
          WHERE conversation_id = v_id AND user_id = auth.uid();

          PERFORM public.purge_conversation(v_id);

          -- Create fresh conversation
          INSERT INTO public.conversations (user1_id, user2_id)
          VALUES (v_u1, v_u2) RETURNING id INTO v_id;
          INSERT INTO public.conversation_status (conversation_id, user_id, has_left)
          VALUES (v_id, v_u1, false), (v_id, v_u2, false);

          -- Restore settings if they existed
          IF v_settings IS NOT NULL THEN
            INSERT INTO public.conversation_settings (
              conversation_id, user_id, pin_hash, is_locked, is_hidden,
              expiry_seconds, theme, wallpaper_url, cleared_at,
              notification_enabled, secret_code_hash, disappear_after_view_enabled
            ) VALUES (
              v_id, auth.uid(), v_settings.pin_hash, v_settings.is_locked,
              v_settings.is_hidden, v_settings.expiry_seconds, v_settings.theme,
              v_settings.wallpaper_url, v_settings.cleared_at,
              v_settings.notification_enabled, v_settings.secret_code_hash,
              v_settings.disappear_after_view_enabled
            );
          END IF;

          PERFORM pg_advisory_unlock(v_lock_key);
          RETURN v_id;
        END IF;

        -- Only current user left: just reset their status
        UPDATE public.conversation_status
        SET has_left = false, left_at = NULL
        WHERE conversation_id = v_id AND user_id = auth.uid();
      END IF;

      PERFORM pg_advisory_unlock(v_lock_key);
      RETURN v_id;
    END IF;

    -- No conversation exists — create new one
    INSERT INTO public.conversations (user1_id, user2_id)
    VALUES (v_u1, v_u2) RETURNING id INTO v_id;
    INSERT INTO public.conversation_status (conversation_id, user_id, has_left)
    VALUES (v_id, v_u1, false), (v_id, v_u2, false);

    PERFORM pg_advisory_unlock(v_lock_key);
    RETURN v_id;
  EXCEPTION
    WHEN unique_violation THEN
      PERFORM pg_advisory_unlock(v_lock_key);
      SELECT id INTO v_id FROM public.conversations
      WHERE user1_id = v_u1 AND user2_id = v_u2;
      RETURN v_id;
    WHEN OTHERS THEN
      PERFORM pg_advisory_unlock(v_lock_key);
      RAISE;
  END;
END $$;

-- 3. FIX: list_my_conversations - ensure all non-hidden conversations are returned
-- The issue was that the LEFT JOIN with settings and the WHERE clause
-- could filter out conversations that don't have a settings row yet.
-- Fix: Move the hidden filter to the JOIN condition or handle NULL properly.
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
    SELECT cs.conversation_id,
           COALESCE(cs.is_hidden, false) as is_hidden,
           COALESCE(cs.is_locked, false) as is_locked,
           cs.pin_hash IS NOT NULL as has_pin,
           cs.cleared_at
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

-- 4. FIX: Add function to check if conversation requires secret code
CREATE OR REPLACE FUNCTION public.check_conversation_secret_code_required(_conv UUID, _user_id UUID)
RETURNS TABLE (required BOOLEAN, has_code BOOLEAN) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_hidden BOOLEAN;
  v_has_code BOOLEAN;
BEGIN
  SELECT is_hidden, secret_code_hash IS NOT NULL
  INTO v_hidden, v_has_code
  FROM public.conversation_settings
  WHERE conversation_id = _conv AND user_id = _user_id;

  IF v_hidden IS NULL THEN
    -- No settings row = not hidden
    RETURN QUERY SELECT false, false;
  ELSE
    RETURN QUERY SELECT v_hidden AND COALESCE(v_has_code, false), COALESCE(v_has_code, false);
  END IF;
END $$;

-- 5. Grant execute on new function
GRANT EXECUTE ON FUNCTION public.check_conversation_secret_code_required(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_or_create_conversation(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_my_conversations() TO authenticated;
GRANT EXECUTE ON FUNCTION public.purge_conversation(UUID) TO authenticated;
