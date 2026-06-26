-- Clear Chat round-based cleanup.
-- A clear hides messages for the caller immediately, then physically deletes
-- only the unsaved range cleared by every active participant in the current
-- cleanup round.

CREATE SEQUENCE IF NOT EXISTS public.messages_clear_seq_seq AS BIGINT;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS clear_seq BIGINT;

WITH ordered AS (
  SELECT
    id,
    row_number() OVER (ORDER BY created_at, id)::BIGINT AS next_seq
  FROM public.messages
  WHERE clear_seq IS NULL
)
UPDATE public.messages m
SET clear_seq = ordered.next_seq
FROM ordered
WHERE m.id = ordered.id;

SELECT setval(
  'public.messages_clear_seq_seq',
  GREATEST((SELECT COALESCE(MAX(clear_seq), 0) FROM public.messages), 1),
  true
);

ALTER TABLE public.messages
  ALTER COLUMN clear_seq SET DEFAULT nextval('public.messages_clear_seq_seq'),
  ALTER COLUMN clear_seq SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS messages_clear_seq_key
  ON public.messages(clear_seq);

CREATE INDEX IF NOT EXISTS messages_conv_clear_seq_idx
  ON public.messages(conversation_id, clear_seq);

CREATE OR REPLACE FUNCTION public.tg_messages_set_clear_seq()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.clear_seq IS NULL THEN
    NEW.clear_seq := nextval('public.messages_clear_seq_seq');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_set_clear_seq ON public.messages;
CREATE TRIGGER messages_set_clear_seq
  BEFORE INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_messages_set_clear_seq();

ALTER TABLE public.conversation_settings
  ADD COLUMN IF NOT EXISTS cleared_through_seq BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS clear_delete_through_seq BIGINT NOT NULL DEFAULT 0;

UPDATE public.conversation_settings cs
SET
  cleared_through_seq = COALESCE((
    SELECT MAX(m.clear_seq)
    FROM public.messages m
    WHERE m.conversation_id = cs.conversation_id
      AND cs.cleared_at IS NOT NULL
      AND m.created_at <= cs.cleared_at
  ), 0),
  clear_delete_through_seq = COALESCE((
    SELECT MAX(m.clear_seq)
    FROM public.messages m
    WHERE m.conversation_id = cs.conversation_id
      AND cs.cleared_at IS NOT NULL
      AND m.created_at <= cs.cleared_at
  ), 0)
WHERE cs.cleared_at IS NOT NULL
  AND (cs.cleared_through_seq = 0 OR cs.clear_delete_through_seq = 0);

CREATE TABLE IF NOT EXISTS public.conversation_clear_state (
  conversation_id UUID PRIMARY KEY REFERENCES public.conversations(id) ON DELETE CASCADE,
  cleanup_through_seq BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.conversation_clear_state ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.conversation_clear_state FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.conversation_clear_state TO service_role;

DROP TRIGGER IF EXISTS conversation_clear_state_set_updated_at ON public.conversation_clear_state;
CREATE TRIGGER conversation_clear_state_set_updated_at
  BEFORE UPDATE ON public.conversation_clear_state
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_set_updated_at();

CREATE OR REPLACE FUNCTION public.clear_conversation_for_me(_conv UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_clear_seq BIGINT := 0;
  v_previous_cleanup_seq BIGINT := 0;
  v_cleanup_seq BIGINT := 0;
  v_participant_count INT := 0;
  v_deleted_count INT := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_conv::TEXT, 0));

  IF NOT EXISTS (
    SELECT 1
    FROM public.conversation_status cs
    WHERE cs.conversation_id = _conv
      AND cs.user_id = v_user_id
      AND cs.has_left = false
  ) THEN
    RAISE EXCEPTION 'not an active participant';
  END IF;

  SELECT COALESCE(MAX(m.clear_seq), 0)
  INTO v_clear_seq
  FROM public.messages m
  WHERE m.conversation_id = _conv;

  INSERT INTO public.conversation_settings (
    conversation_id,
    user_id,
    cleared_at,
    cleared_through_seq,
    clear_delete_through_seq
  )
  VALUES (_conv, v_user_id, now(), v_clear_seq, v_clear_seq)
  ON CONFLICT (conversation_id, user_id)
  DO UPDATE SET
    cleared_at = EXCLUDED.cleared_at,
    cleared_through_seq = EXCLUDED.cleared_through_seq,
    clear_delete_through_seq = EXCLUDED.clear_delete_through_seq,
    updated_at = now();

  INSERT INTO public.conversation_clear_state (conversation_id, cleanup_through_seq)
  VALUES (_conv, 0)
  ON CONFLICT (conversation_id) DO NOTHING;

  SELECT cleanup_through_seq
  INTO v_previous_cleanup_seq
  FROM public.conversation_clear_state
  WHERE conversation_id = _conv;

  WITH active_participants AS (
    SELECT cs.user_id
    FROM public.conversation_status cs
    WHERE cs.conversation_id = _conv
      AND cs.has_left = false
  ),
  participant_settings AS (
    SELECT COALESCE(s.clear_delete_through_seq, 0) AS clear_delete_through_seq
    FROM active_participants ap
    LEFT JOIN public.conversation_settings s
      ON s.conversation_id = _conv
     AND s.user_id = ap.user_id
  )
  SELECT COUNT(*)::INT, COALESCE(MIN(clear_delete_through_seq), 0)
  INTO v_participant_count, v_cleanup_seq
  FROM participant_settings;

  IF v_participant_count > 0 AND v_cleanup_seq > v_previous_cleanup_seq THEN
    WITH deleted AS (
      DELETE FROM public.messages m
      WHERE m.conversation_id = _conv
        AND m.clear_seq > v_previous_cleanup_seq
        AND m.clear_seq <= v_cleanup_seq
        AND NOT EXISTS (
          SELECT 1
          FROM public.message_saves s
          WHERE s.message_id = m.id
        )
      RETURNING m.id
    )
    SELECT COUNT(*)::INT
    INTO v_deleted_count
    FROM deleted;

    UPDATE public.conversation_clear_state
    SET cleanup_through_seq = v_cleanup_seq,
        updated_at = now()
    WHERE conversation_id = _conv;

    UPDATE public.conversation_settings s
    SET clear_delete_through_seq = v_cleanup_seq,
        updated_at = now()
    WHERE s.conversation_id = _conv
      AND EXISTS (
        SELECT 1
        FROM public.conversation_status cs
        WHERE cs.conversation_id = _conv
          AND cs.user_id = s.user_id
          AND cs.has_left = false
      );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'clearedThroughSeq', v_clear_seq,
    'cleanupThroughSeq', GREATEST(v_cleanup_seq, v_previous_cleanup_seq),
    'deletedRows', v_deleted_count,
    'participantCount', v_participant_count
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.clear_conversation_for_me(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clear_conversation_for_me(UUID) TO authenticated;

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
  cleared_at TIMESTAMPTZ,
  removed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  RETURN QUERY
  WITH my_convs AS (
    SELECT c.id, c.user1_id, c.user2_id, c.last_message_at
    FROM public.conversations c
    JOIN public.conversation_status cs ON cs.conversation_id = c.id
    WHERE cs.user_id = v_user_id
  ),
  settings AS (
    SELECT cs.conversation_id,
           COALESCE(cs.is_hidden, false) AS is_hidden,
           COALESCE(cs.is_locked, false) AS is_locked,
           cs.pin_hash IS NOT NULL AS has_pin,
           cs.cleared_at,
           COALESCE(cs.cleared_through_seq, 0) AS cleared_through_seq,
           cs.removed_at
    FROM public.conversation_settings cs
    WHERE cs.user_id = v_user_id
  ),
  last_msgs AS (
    SELECT DISTINCT ON (m.conversation_id)
      m.conversation_id, m.content, m.message_type, m.created_at, m.sender_id
    FROM public.messages m
    LEFT JOIN settings s ON s.conversation_id = m.conversation_id
    WHERE m.conversation_id IN (SELECT mc.id FROM my_convs mc)
      AND m.clear_seq > COALESCE(s.cleared_through_seq, 0)
      AND (
        m.expires_at IS NULL
        OR m.expires_at > now()
        OR EXISTS (
          SELECT 1
          FROM public.message_saves save
          WHERE save.message_id = m.id
        )
      )
    ORDER BY m.conversation_id, m.clear_seq DESC
  ),
  unread_counts AS (
    SELECT m.conversation_id, COUNT(*) AS cnt
    FROM public.messages m
    LEFT JOIN settings s ON s.conversation_id = m.conversation_id
    WHERE m.conversation_id IN (SELECT mc.id FROM my_convs mc)
      AND m.clear_seq > COALESCE(s.cleared_through_seq, 0)
      AND m.read_at IS NULL
      AND m.sender_id <> v_user_id
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
    ) AS other,
    CASE WHEN lm.conversation_id IS NOT NULL THEN
      jsonb_build_object(
        'content', lm.content,
        'message_type', lm.message_type,
        'created_at', lm.created_at,
        'sender_id', lm.sender_id
      )
    ELSE NULL END AS last,
    COALESCE(uc.cnt, 0)::BIGINT AS unread,
    COALESCE(lm.created_at, mc.last_message_at) AS last_message_at,
    COALESCE(s.is_hidden, false) AS hidden,
    COALESCE(s.is_locked, false) AS locked,
    COALESCE(s.has_pin, false) AS has_pin,
    s.cleared_at,
    s.removed_at
  FROM my_convs mc
  LEFT JOIN settings s ON s.conversation_id = mc.id
  LEFT JOIN last_msgs lm ON lm.conversation_id = mc.id
  LEFT JOIN unread_counts uc ON uc.conversation_id = mc.id
  LEFT JOIN public.profiles p ON p.id = CASE WHEN mc.user1_id = v_user_id THEN mc.user2_id ELSE mc.user1_id END
  WHERE mc.id IS NOT NULL
    AND (
      COALESCE(s.is_hidden, false) = true
      OR (
        s.removed_at IS NULL
        AND (
          COALESCE(s.cleared_through_seq, 0) = 0
          OR lm.conversation_id IS NOT NULL
        )
      )
      OR (
        s.removed_at IS NOT NULL
        AND lm.created_at > s.removed_at
      )
      OR COALESCE(uc.cnt, 0) > 0
    )
  ORDER BY COALESCE(lm.created_at, mc.last_message_at) DESC NULLS LAST;
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_my_conversations() TO authenticated;
