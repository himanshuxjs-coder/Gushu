-- ============================================================
-- FIX: Settings must NEVER reset. When both users leave,
-- keep the same conversation ID, only delete messages for privacy.
-- This preserves all settings (theme, PIN, wallpaper, expiry, etc.)
-- permanently until manually changed.
-- ============================================================

-- 1. FIX: get_or_create_conversation - never create new conversation
-- When both left: delete messages for privacy, reset both status, keep conversation+settings
CREATE OR REPLACE FUNCTION public.get_or_create_conversation(_other_user UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_u1 UUID;
  v_u2 UUID;
  v_id UUID;
  v_my_left BOOLEAN;
  v_other_left BOOLEAN;
  v_lock_key BIGINT;
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
          -- BOTH left: purge messages for privacy, but KEEP conversation + settings
          DELETE FROM public.message_reactions WHERE message_id IN (
            SELECT id FROM public.messages WHERE conversation_id = v_id
          );
          DELETE FROM public.message_deletions WHERE message_id IN (
            SELECT id FROM public.messages WHERE conversation_id = v_id
          );
          DELETE FROM public.messages WHERE conversation_id = v_id;

          -- Reset both users' status to not-left
          UPDATE public.conversation_status
          SET has_left = false, left_at = NULL
          WHERE conversation_id = v_id;
        ELSE
          -- Only current user left: just reset their status
          UPDATE public.conversation_status
          SET has_left = false, left_at = NULL
          WHERE conversation_id = v_id AND user_id = auth.uid();
        END IF;
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

-- 2. FIX: leave_conversation - when both left, only delete messages, keep conversation+settings
CREATE OR REPLACE FUNCTION public.leave_conversation(_conv UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_both_left BOOLEAN;
BEGIN
  IF NOT public.is_conversation_participant(_conv, auth.uid()) THEN
    RAISE EXCEPTION 'not a participant';
  END IF;

  UPDATE public.conversation_status
  SET has_left = true, left_at = now()
  WHERE conversation_id = _conv AND user_id = auth.uid();

  SELECT bool_and(has_left) INTO v_both_left
  FROM public.conversation_status
  WHERE conversation_id = _conv;

  IF v_both_left THEN
    -- Both left: delete messages for privacy, but KEEP conversation + settings
    DELETE FROM public.message_reactions WHERE message_id IN (
      SELECT id FROM public.messages WHERE conversation_id = _conv
    );
    DELETE FROM public.message_deletions WHERE message_id IN (
      SELECT id FROM public.messages WHERE conversation_id = _conv
    );
    DELETE FROM public.messages WHERE conversation_id = _conv;

    -- Reset both users' status (conversation stays alive with same ID)
    UPDATE public.conversation_status
    SET has_left = false, left_at = NULL
    WHERE conversation_id = _conv;

    RETURN true;
  END IF;

  RETURN false;
END $$;

-- 3. purge_conversation is now only for admin/emergency use
-- It still deletes settings since it's a full purge
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

-- 4. Grant execute
GRANT EXECUTE ON FUNCTION public.get_or_create_conversation(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.leave_conversation(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.purge_conversation(UUID) TO authenticated;
