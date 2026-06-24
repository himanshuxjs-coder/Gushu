-- Enable the pg_net extension to allow HTTP requests from SQL
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Ensure the push tokens table exists
CREATE TABLE IF NOT EXISTS public.user_push_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    device_type TEXT, -- 'android', 'ios', 'web'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, token)
);

-- Enable RLS
ALTER TABLE public.user_push_tokens ENABLE ROW LEVEL SECURITY;

-- Policies for user_push_tokens
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_push_tokens' AND policyname = 'Users can insert their own tokens') THEN
        CREATE POLICY "Users can insert their own tokens" ON public.user_push_tokens FOR INSERT WITH CHECK (auth.uid() = user_id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_push_tokens' AND policyname = 'Users can view their own tokens') THEN
        CREATE POLICY "Users can view their own tokens" ON public.user_push_tokens FOR SELECT USING (auth.uid() = user_id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_push_tokens' AND policyname = 'Users can delete their own tokens') THEN
        CREATE POLICY "Users can delete their own tokens" ON public.user_push_tokens FOR DELETE USING (auth.uid() = user_id);
    END IF;
END $$;

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_user_push_tokens_updated_at ON public.user_push_tokens;
CREATE TRIGGER update_user_push_tokens_updated_at
    BEFORE UPDATE ON public.user_push_tokens
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

-- Function to handle sending the actual notification via Edge Function
CREATE OR REPLACE FUNCTION public.handle_new_message_push_notification()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net, extensions
AS $$
DECLARE
    v_host TEXT;
    v_token_record RECORD;
BEGIN
    -- Only trigger on new message insertion
    IF TG_OP != 'INSERT' THEN
        RETURN NEW;
    END IF;

    -- Replace with your actual project ref
    v_host := 'kezctmxbtzmyrqiixlwn.supabase.co';

    -- Loop through tokens and queue HTTP requests
    FOR v_token_record IN
        SELECT DISTINCT upt.token
        FROM public.user_push_tokens upt
        JOIN public.conversation_status cs ON cs.user_id = upt.user_id
        WHERE cs.conversation_id = NEW.conversation_id
          AND cs.user_id != NEW.sender_id
    LOOP
        BEGIN
            -- Direct call to http_post (assumes pg_net is available in search path)
            PERFORM http_post(
                url := 'https://' || v_host || '/functions/v1/push-notifications',
                headers := '{"Content-Type": "application/json"}'::jsonb,
                body := jsonb_build_object(
                    'tokens', ARRAY[v_token_record.token],
                    'title', 'Gushu',
                    'body', 'Knock Knock 👋',
                    'data', jsonb_build_object('conversation_id', NEW.conversation_id::text)
                )
            );
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'Push notification failed for token %: %', v_token_record.token, SQLERRM;
        END;
    END LOOP;

    RETURN NEW;
END;
$$;

-- Create the trigger on messages table
DROP TRIGGER IF EXISTS on_new_message_push_notification ON public.messages;
CREATE TRIGGER on_new_message_push_notification
    AFTER INSERT ON public.messages
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_message_push_notification();
