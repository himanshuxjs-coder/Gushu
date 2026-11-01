-- Use a transaction-scoped advisory lock for conversation creation.
-- Session-scoped advisory locks can survive a cancelled RPC on pooled connections
-- and block later attempts to open the same conversation.

CREATE OR REPLACE FUNCTION public.get_or_create_conversation(_other_user uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_u1 UUID;
  v_u2 UUID;
  v_id UUID;
  v_my_left BOOLEAN;
  v_other_left BOOLEAN;
  v_lock_key BIGINT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF _other_user = auth.uid() THEN
    RAISE EXCEPTION 'cannot start a conversation with yourself';
  END IF;

  IF auth.uid() < _other_user THEN
    v_u1 := auth.uid();
    v_u2 := _other_user;
  ELSE
    v_u1 := _other_user;
    v_u2 := auth.uid();
  END IF;

  v_lock_key := hashtext(v_u1::text || ':' || v_u2::text);

  -- Bound lock waiting and release the lock automatically at transaction end.
  SET LOCAL lock_timeout = '8s';
  PERFORM pg_advisory_xact_lock(v_lock_key);

  BEGIN
    SELECT id INTO v_id
    FROM public.conversations
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
          -- BOTH left: purge messages for privacy, but keep conversation + settings.
          DELETE FROM public.message_reactions
          WHERE message_id IN (
            SELECT id FROM public.messages WHERE conversation_id = v_id
          );

          DELETE FROM public.message_deletions
          WHERE message_id IN (
            SELECT id FROM public.messages WHERE conversation_id = v_id
          );

          DELETE FROM public.messages
          WHERE conversation_id = v_id;

          UPDATE public.conversation_status
          SET has_left = false, left_at = NULL
          WHERE conversation_id = v_id;
        ELSE
          -- Only current user left: reset their status.
          UPDATE public.conversation_status
          SET has_left = false, left_at = NULL
          WHERE conversation_id = v_id AND user_id = auth.uid();
        END IF;
      END IF;

      RETURN v_id;
    END IF;

    INSERT INTO public.conversations (user1_id, user2_id)
    VALUES (v_u1, v_u2)
    RETURNING id INTO v_id;

    INSERT INTO public.conversation_status (conversation_id, user_id, has_left)
    VALUES (v_id, v_u1, false), (v_id, v_u2, false);

    RETURN v_id;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT id INTO v_id
      FROM public.conversations
      WHERE user1_id = v_u1 AND user2_id = v_u2;
      RETURN v_id;
    WHEN OTHERS THEN
      RAISE;
  END;
END;
$function$;
