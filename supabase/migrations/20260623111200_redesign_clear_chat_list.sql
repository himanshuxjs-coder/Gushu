-- ============================================================
-- Fix: Redesign list_my_conversations to hide cleared chats
-- A conversation will only be listed if:
-- 1. It is hidden (so it can be managed in hidden chats view)
-- 2. OR it hasn't been cleared
-- 3. OR it has a last_message_at newer than the last clear action
-- ============================================================

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
    -- Get all conversations where the user is a participant and hasn't left
    SELECT c.id, c.user1_id, c.user2_id, c.last_message_at
    FROM public.conversations c
    JOIN public.conversation_status cs ON cs.conversation_id = c.id
    WHERE cs.user_id = v_user_id AND cs.has_left = false
  ),
  settings AS (
    -- Get settings for these conversations
    SELECT cs.conversation_id,
           COALESCE(cs.is_hidden, false) as is_hidden,
           COALESCE(cs.is_locked, false) as is_locked,
           cs.pin_hash IS NOT NULL as has_pin,
           cs.cleared_at
    FROM public.conversation_settings cs
    WHERE cs.user_id = v_user_id
  ),
  last_msgs AS (
    -- Get the last message for each conversation efficiently
    SELECT DISTINCT ON (m.conversation_id)
      m.conversation_id, m.content, m.message_type, m.created_at, m.sender_id
    FROM public.messages m
    WHERE m.conversation_id IN (SELECT mc.id FROM my_convs mc)
    ORDER BY m.conversation_id, m.created_at DESC
  ),
  unread_counts AS (
    -- Count unread messages (received by user)
    SELECT m.conversation_id, COUNT(*) as cnt
    FROM public.messages m
    WHERE m.conversation_id IN (SELECT mc.id FROM my_convs mc)
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
  WHERE mc.id IS NOT NULL
    AND (
      -- Rule 1: Always include hidden chats (management view needs them)
      COALESCE(s.is_hidden, false) = true
      OR 
      -- Rule 2: Non-hidden chats must NOT be cleared OR have messages newer than cleared_at
      (s.cleared_at IS NULL OR mc.last_message_at > s.cleared_at)
    );
END $$;
