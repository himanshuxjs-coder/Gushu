-- Fix saved-message expiry behavior:
-- 1. Saved messages should never start or continue an expiry countdown.
-- 2. Saving a message cancels any active expires_at timer.
-- 3. Unsaving the last save restarts a fresh countdown from the unsave time if the message has already been seen.
-- 4. Messages seen while saved do not receive an expiry until they become unsaved.

CREATE OR REPLACE FUNCTION public.save_message(_msg_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_conv_id uuid;
BEGIN
  SELECT conversation_id INTO v_conv_id FROM public.messages WHERE id = _msg_id;
  IF v_conv_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.message_saves (user_id, message_id, conversation_id)
  VALUES (auth.uid(), _msg_id, v_conv_id)
  ON CONFLICT (user_id, message_id) DO NOTHING;

  INSERT INTO public.message_clear_exemptions (message_id, user_id, cleared_at)
  VALUES (_msg_id, auth.uid(), NOW())
  ON CONFLICT (message_id, user_id) DO NOTHING;

  -- Cancel any active expiry timer while the message is saved.
  UPDATE public.messages
  SET expires_at = NULL
  WHERE id = _msg_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.unsave_message(_msg_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_conv_id uuid;
  v_read_at timestamptz;
  v_expiry_seconds int;
  v_has_save boolean;
BEGIN
  DELETE FROM public.message_saves
  WHERE user_id = auth.uid() AND message_id = _msg_id;

  SELECT EXISTS(SELECT 1 FROM public.message_saves WHERE message_id = _msg_id) INTO v_has_save;
  IF v_has_save THEN
    RETURN;
  END IF;

  SELECT conversation_id, read_at INTO v_conv_id, v_read_at
  FROM public.messages
  WHERE id = _msg_id;

  IF v_conv_id IS NULL OR v_read_at IS NULL THEN
    RETURN;
  END IF;

  SELECT expiry_seconds INTO v_expiry_seconds
  FROM public.conversations
  WHERE id = v_conv_id;

  IF v_expiry_seconds IS NULL OR v_expiry_seconds <= 0 THEN
    RETURN;
  END IF;

  UPDATE public.messages
  SET expires_at = NOW() + make_interval(secs => v_expiry_seconds)
  WHERE id = _msg_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.mark_message_viewed(_msg_id uuid, _viewer_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  msg_rec RECORD;
  v_expiry_seconds INT;
  v_now TIMESTAMPTZ := NOW();
  v_first_view TIMESTAMPTZ;
  v_is_saved BOOL;
BEGIN
  SELECT * INTO msg_rec FROM public.messages WHERE id = _msg_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO public.message_user_views (message_id, user_id, viewed_at)
  VALUES (_msg_id, _viewer_id, v_now)
  ON CONFLICT (message_id, user_id) DO UPDATE
    SET viewed_at = LEAST(message_user_views.viewed_at, EXCLUDED.viewed_at);

  IF msg_rec.sender_id = _viewer_id THEN
    RETURN;
  END IF;

  UPDATE public.messages
  SET viewed_at = COALESCE(viewed_at, v_now),
      read_at = COALESCE(read_at, v_now),
      first_read_at = COALESCE(first_read_at, v_now)
  WHERE id = _msg_id AND (read_at IS NULL OR viewed_at IS NULL);

  SELECT EXISTS(SELECT 1 FROM public.message_saves WHERE message_id = _msg_id) INTO v_is_saved;
  IF v_is_saved THEN
    RETURN;
  END IF;

  SELECT expiry_seconds INTO v_expiry_seconds
  FROM public.conversations WHERE id = msg_rec.conversation_id;

  IF v_expiry_seconds IS NOT NULL AND v_expiry_seconds > 0 AND msg_rec.expires_at IS NULL THEN
    SELECT first_read_at INTO v_first_view FROM public.messages WHERE id = _msg_id;
    UPDATE public.messages
    SET expires_at = COALESCE(v_first_view, v_now) + make_interval(secs => v_expiry_seconds)
    WHERE id = _msg_id AND expires_at IS NULL;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.mark_conversation_read(_conv_id uuid, _viewer_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_expiry_seconds INT;
  v_now TIMESTAMPTZ := NOW();
  msg RECORD;
  v_is_saved BOOL;
BEGIN
  SELECT expiry_seconds INTO v_expiry_seconds
  FROM public.conversations WHERE id = _conv_id;

  FOR msg IN
    SELECT id, sender_id, expires_at, first_read_at
    FROM public.messages
    WHERE conversation_id = _conv_id
      AND sender_id <> _viewer_id
      AND (read_at IS NULL OR viewed_at IS NULL)
  LOOP
    INSERT INTO public.message_user_views (message_id, user_id, viewed_at)
    VALUES (msg.id, _viewer_id, v_now)
    ON CONFLICT (message_id, user_id) DO UPDATE
      SET viewed_at = LEAST(message_user_views.viewed_at, EXCLUDED.viewed_at);

    UPDATE public.messages
    SET viewed_at = COALESCE(viewed_at, v_now),
        read_at = COALESCE(read_at, v_now),
        first_read_at = COALESCE(first_read_at, v_now)
    WHERE id = msg.id;

    SELECT EXISTS(SELECT 1 FROM public.message_saves WHERE message_id = msg.id) INTO v_is_saved;
    IF v_is_saved THEN
      CONTINUE;
    END IF;

    IF v_expiry_seconds IS NOT NULL AND v_expiry_seconds > 0 AND msg.expires_at IS NULL THEN
      UPDATE public.messages
      SET expires_at = COALESCE(first_read_at, v_now) + make_interval(secs => v_expiry_seconds)
      WHERE id = msg.id AND expires_at IS NULL;
    END IF;
  END LOOP;
END;
$function$;
