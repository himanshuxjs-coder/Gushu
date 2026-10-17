-- Repair the deployed RPC. Some existing databases have UNIQUE(token),
-- while newer schemas use UNIQUE(user_id, token); avoid a brittle ON CONFLICT
-- target and update the existing token row explicitly.
DROP FUNCTION IF EXISTS public.register_push_token(TEXT, TEXT);

CREATE FUNCTION public.register_push_token(
  p_token TEXT,
  p_device_type TEXT DEFAULT 'android'
)
RETURNS TABLE(success BOOLEAN, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_user_id UUID := auth.uid();
BEGIN
  IF current_user_id IS NULL THEN
    RETURN QUERY SELECT false, 'User is not authenticated';
    RETURN;
  END IF;

  IF p_token IS NULL OR btrim(p_token) = '' THEN
    RETURN QUERY SELECT false, 'Token is required';
    RETURN;
  END IF;

  UPDATE public.user_push_tokens
  SET user_id = current_user_id,
      device_type = COALESCE(p_device_type, 'android'),
      updated_at = NOW()
  WHERE token = p_token;

  IF NOT FOUND THEN
    INSERT INTO public.user_push_tokens (user_id, token, device_type)
    VALUES (current_user_id, p_token, COALESCE(p_device_type, 'android'));
  END IF;

  RETURN QUERY SELECT true, 'Token registered';
EXCEPTION
  WHEN OTHERS THEN
    RETURN QUERY SELECT false, SQLERRM;
END;
$$;

GRANT EXECUTE ON FUNCTION public.register_push_token(TEXT, TEXT) TO authenticated;