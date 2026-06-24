-- Clean up duplicate tokens by keeping only the most recently updated record for each token
DELETE FROM public.user_push_tokens
WHERE id IN (
    SELECT id
    FROM (
        SELECT id,
               ROW_NUMBER() OVER (PARTITION BY token ORDER BY updated_at DESC) as rn
        FROM public.user_push_tokens
    ) t
    WHERE t.rn > 1
);

-- Drop the previous non-unique or differently unique indexes if they exist
ALTER TABLE public.user_push_tokens DROP CONSTRAINT IF EXISTS user_push_tokens_user_id_token_key;
ALTER TABLE public.user_push_tokens DROP CONSTRAINT IF EXISTS user_push_tokens_token_key;

-- Add UNIQUE constraint on token column to ensure one-to-one mapping
ALTER TABLE public.user_push_tokens ADD CONSTRAINT user_push_tokens_token_key UNIQUE (token);

-- Create SECURITY DEFINER RPC functions for push token management
-- These handle the ownership transfer entirely on the server side

CREATE OR REPLACE FUNCTION public.register_push_token(p_token TEXT, p_device_type TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Delete any existing row using that token (ownership transfer)
    DELETE FROM public.user_push_tokens WHERE token = p_token;
    
    -- Insert a new row assigning the token to the currently authenticated user
    INSERT INTO public.user_push_tokens (user_id, token, device_type)
    VALUES (auth.uid(), p_token, p_device_type);
EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Failed to register push token: %', SQLERRM;
END;
$$;

CREATE OR REPLACE FUNCTION public.unregister_push_token(p_token TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Delete the row using that token
    DELETE FROM public.user_push_tokens WHERE token = p_token;
EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Failed to unregister push token: %', SQLERRM;
END;
$$;

-- Grant permissions to authenticated users
GRANT EXECUTE ON FUNCTION public.register_push_token(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unregister_push_token(TEXT) TO authenticated;
