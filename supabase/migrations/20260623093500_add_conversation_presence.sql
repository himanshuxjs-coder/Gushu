-- 1. Create table for tracking active conversations
CREATE TABLE IF NOT EXISTS public.active_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Create indexes as requested
CREATE UNIQUE INDEX IF NOT EXISTS active_conversations_user_idx
ON public.active_conversations(user_id);

CREATE INDEX IF NOT EXISTS active_conversations_lookup_idx
ON public.active_conversations(user_id, conversation_id);

CREATE INDEX IF NOT EXISTS active_conversations_updated_idx
ON public.active_conversations(updated_at);

-- 3. Enable RLS
ALTER TABLE public.active_conversations ENABLE ROW LEVEL SECURITY;

-- 4. RLS Policies
DROP POLICY IF EXISTS "Users manage own active conversation" ON public.active_conversations;
CREATE POLICY "Users manage own active conversation"
ON public.active_conversations
FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- 5. Stale record cleanup function
CREATE OR REPLACE FUNCTION public.cleanup_stale_active_conversations()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    DELETE
    FROM public.active_conversations
    WHERE updated_at < NOW() - INTERVAL '5 minutes';
END;
$$;

-- 6. Update push notification trigger to check for active conversations
-- Suppression logic: User must be in the conversation AND presence must be fresh (60s)
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

    -- Use the project URL
    v_host := 'xzeqhoolzewzojjodzmx.supabase.co';

    -- Loop through tokens of everyone in the conversation EXCEPT the sender
    FOR v_token_record IN 
        SELECT DISTINCT upt.token, upt.user_id
        FROM public.user_push_tokens upt
        JOIN public.conversation_status cs ON cs.user_id = upt.user_id
        WHERE cs.conversation_id = NEW.conversation_id 
          AND cs.user_id != NEW.sender_id
    LOOP
        -- SKIP notification if the user is currently viewing THIS specific conversation
        IF EXISTS (
            SELECT 1
            FROM public.active_conversations ac
            WHERE ac.user_id = v_token_record.user_id
              AND ac.conversation_id = NEW.conversation_id
              AND ac.updated_at > NOW() - INTERVAL '60 seconds'
        ) THEN
            CONTINUE;
        END IF;

        BEGIN
            -- Direct call to pg_net's http_post
            PERFORM http_post(
                url := 'https://' || v_host || '/functions/v1/push-notifications',
                headers := jsonb_build_object(
                    'Content-Type', 'application/json'
                ),
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
