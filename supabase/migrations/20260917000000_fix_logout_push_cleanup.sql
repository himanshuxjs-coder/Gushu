-- Ensure the push-token table exists and provide logout-safe cleanup RPCs.
CREATE TABLE IF NOT EXISTS public.user_push_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  device_type TEXT NOT NULL DEFAULT 'android' CHECK (device_type IN ('android', 'ios', 'web')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, token)
);

ALTER TABLE public.user_push_tokens ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.register_push_token(p_token TEXT, p_device_type TEXT)
RETURNS TABLE(success BOOLEAN, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_token IS NULL OR p_token = '' THEN
    RETURN QUERY SELECT false, 'Token is required';
    RETURN;
  END IF;

  INSERT INTO public.user_push_tokens (user_id, token, device_type)
  VALUES (auth.uid(), p_token, COALESCE(p_device_type, 'android'))
  ON CONFLICT (user_id, token)
  DO UPDATE SET device_type = EXCLUDED.device_type, updated_at = NOW();

  RETURN QUERY SELECT true, 'Token registered';
END;
$$;

CREATE OR REPLACE FUNCTION public.unregister_push_token(p_token TEXT)
RETURNS TABLE(success BOOLEAN, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_token IS NULL OR p_token = '' THEN
    RETURN QUERY SELECT false, 'Token is required';
    RETURN;
  END IF;

  DELETE FROM public.user_push_tokens
  WHERE user_id = auth.uid()
    AND token = p_token;

  RETURN QUERY SELECT true, 'Token removed';
END;
$$;

DROP POLICY IF EXISTS "users_manage_own_push_tokens" ON public.user_push_tokens;
CREATE POLICY "users_manage_own_push_tokens"
  ON public.user_push_tokens
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_push_tokens TO authenticated;
GRANT EXECUTE ON FUNCTION public.register_push_token(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unregister_push_token(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_user_push_tokens_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_push_tokens_updated_at ON public.user_push_tokens;
CREATE TRIGGER user_push_tokens_updated_at
BEFORE UPDATE ON public.user_push_tokens
FOR EACH ROW
EXECUTE FUNCTION public.set_user_push_tokens_updated_at();
