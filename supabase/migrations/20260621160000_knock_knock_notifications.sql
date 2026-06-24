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

-- Enable RLS if not already enabled
ALTER TABLE public.user_push_tokens ENABLE ROW LEVEL SECURITY;

-- Add basic policies if they don't exist
-- (Using DO block for idempotency in case policies exist)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_push_tokens' AND policyname = 'Users can insert their own tokens') THEN
        CREATE POLICY "Users can insert their own tokens" ON public.user_push_tokens FOR INSERT WITH CHECK (auth.uid() = user_id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_push_tokens' AND policyname = 'Users can view their own tokens') THEN
        CREATE POLICY "Users can view their own tokens" ON public.user_push_tokens FOR SELECT USING (auth.uid() = user_id);
    END IF;
END $$;

-- Create a unified function for 'Knock Knock' notifications
CREATE OR REPLACE FUNCTION public.handle_knock_knock_notification()
RETURNS TRIGGER AS $$
DECLARE
    recipient_ids UUID[];
    token_record RECORD;
    conv_id UUID;
    sender_id UUID;
BEGIN
    -- Determine conversation_id and sender based on table
    IF TG_TABLE_NAME = 'messages' THEN
        conv_id := NEW.conversation_id;
        sender_id := NEW.sender_id;
    ELSIF TG_TABLE_NAME = 'message_reactions' THEN
        SELECT conversation_id INTO conv_id FROM public.messages WHERE id = NEW.message_id;
        sender_id := NEW.user_id;
    ELSE
        RETURN NEW;
    END IF;

    -- Get recipients (excluding the actor)
    SELECT ARRAY(
        SELECT user_id 
        FROM public.conversation_status 
        WHERE conversation_id = conv_id AND user_id != sender_id
    ) INTO recipient_ids;

    -- Send "Knock Knock" to everyone else
    FOR token_record IN (
        SELECT token FROM public.user_push_tokens WHERE user_id = ANY(recipient_ids)
    ) LOOP
        PERFORM net.http_post(
            url := 'https://' || (current_setting('request.headers', true)::jsonb->>'host') || '/functions/v1/push-notifications',
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'Authorization', 'Bearer ' || (current_setting('request.jwt.claims', true)::jsonb->>'role')
            ),
            body := jsonb_build_object(
                'tokens', ARRAY[token_record.token],
                'title', 'Gushu',
                'body', 'Knock Knock 👋',
                'data', jsonb_build_object(
                    'conversation_id', conv_id::text
                )
            )
        );
    END LOOP;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Cleanup any old notification triggers
DROP TRIGGER IF EXISTS on_new_message_push_notification ON public.messages;
DROP TRIGGER IF EXISTS on_new_message_knock_knock ON public.messages;
DROP TRIGGER IF EXISTS on_new_reaction_knock_knock ON public.message_reactions;

-- Create unified triggers
CREATE TRIGGER on_new_message_knock_knock
    AFTER INSERT ON public.messages
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_knock_knock_notification();

CREATE TRIGGER on_new_reaction_knock_knock
    AFTER INSERT ON public.message_reactions
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_knock_knock_notification();
