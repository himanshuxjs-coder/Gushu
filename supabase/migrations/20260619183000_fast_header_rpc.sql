-- Deterministic High-performance RPC using explicit user_id to avoid auth.uid() issues on server-side
CREATE OR REPLACE FUNCTION public.get_conversation_with_header_data(_conv_id UUID, _user_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_conv_data RECORD;
  v_isHidden BOOLEAN;
  v_hasLeft BOOLEAN;
  v_other_profile RECORD;
  v_other_id UUID;
BEGIN
  -- 1. Check if user is a participant and has not left
  SELECT has_left INTO v_hasLeft 
  FROM public.conversation_status 
  WHERE conversation_id = _conv_id AND user_id = _user_id;

  -- If not in conversation_status at all, they shouldn't see it
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- 2. Get hidden settings
  SELECT is_hidden INTO v_isHidden
  FROM public.conversation_settings
  WHERE conversation_id = _conv_id AND user_id = _user_id;
  
  v_isHidden := COALESCE(v_isHidden, false);

  -- 3. If hidden and user has left, don't show it (safety check)
  IF v_isHidden AND COALESCE(v_hasLeft, false) THEN
    -- Optimization: if user just hid it, they should still see details until they leave
    -- But if they HAVE left, it returns NULL
    RETURN NULL;
  END IF;

  -- 4. Get the conversation row to find the other user
  SELECT user1_id, user2_id INTO v_conv_data
  FROM public.conversations
  WHERE id = _conv_id;

  IF NOT FOUND THEN RETURN NULL; END IF;

  -- 5. Determine otherId
  v_other_id := CASE 
    WHEN v_conv_data.user1_id = _user_id THEN v_conv_data.user2_id 
    WHEN v_conv_data.user2_id = _user_id THEN v_conv_data.user1_id
    ELSE NULL 
  END;

  IF v_other_id IS NULL THEN RETURN NULL; END IF;

  -- 6. Get other profile directly
  SELECT id, username, display_name, avatar_url, verified, bio, last_seen_at INTO v_other_profile
  FROM public.profiles
  WHERE id = v_other_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('id', _conv_id, 'other', null);
  END IF;

  RETURN jsonb_build_object(
    'id', _conv_id,
    'other', jsonb_build_object(
      'id', v_other_profile.id,
      'username', v_other_profile.username,
      'display_name', v_other_profile.display_name,
      'avatar_url', v_other_profile.avatar_url,
      'verified', v_other_profile.verified,
      'last_seen_at', v_other_profile.last_seen_at
    )
  );
END $$;

GRANT EXECUTE ON FUNCTION public.get_conversation_with_header_data(UUID, UUID) TO authenticated;
