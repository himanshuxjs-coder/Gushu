-- Fix: get_or_create_conversation must release advisory lock
-- The previous version acquired the lock but never released it,
-- which would cause deadlocks over time.
CREATE OR REPLACE FUNCTION public.get_or_create_conversation(_other_user UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_u1 UUID;
  v_u2 UUID;
  v_id UUID;
  v_my_left BOOLEAN;
  v_lock_key BIGINT;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF _other_user = auth.uid() THEN RAISE EXCEPTION 'cannot start a conversation with yourself'; END IF;

  -- Enforce ordering for consistent lookup
  IF auth.uid() < _other_user THEN
    v_u1 := auth.uid(); v_u2 := _other_user;
  ELSE
    v_u1 := _other_user; v_u2 := auth.uid();
  END IF;

  -- Compute lock key from user pair
  v_lock_key := hashtext(v_u1::text || ':' || v_u2::text);

  -- Acquire advisory lock
  PERFORM pg_advisory_lock(v_lock_key);

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

      -- Release lock and return existing conversation ID
      PERFORM pg_advisory_unlock(v_lock_key);
      RETURN v_id;
    END IF;

    -- No conversation exists — create new one
    INSERT INTO public.conversations (user1_id, user2_id)
    VALUES (v_u1, v_u2) RETURNING id INTO v_id;

    INSERT INTO public.conversation_status (conversation_id, user_id, has_left)
    VALUES (v_id, v_u1, false), (v_id, v_u2, false);

    -- Release lock and return
    PERFORM pg_advisory_unlock(v_lock_key);
    RETURN v_id;
  EXCEPTION
    WHEN unique_violation THEN
      -- Race condition: another session created it. Find and return it.
      PERFORM pg_advisory_unlock(v_lock_key);
      SELECT id INTO v_id FROM public.conversations
      WHERE user1_id = v_u1 AND user2_id = v_u2;
      RETURN v_id;
    WHEN OTHERS THEN
      -- Always release lock on any error
      PERFORM pg_advisory_unlock(v_lock_key);
      RAISE;
  END;
END $$;

GRANT EXECUTE ON FUNCTION public.get_or_create_conversation(UUID) TO authenticated;
