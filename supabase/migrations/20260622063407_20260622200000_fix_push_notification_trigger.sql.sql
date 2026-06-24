-- Update the push notification function to use the correct project URL
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

    -- Use the correct project URL
    v_host := 'xzeqhoolzewzojjodzmx.supabase.co';

    -- Loop through tokens of everyone in the conversation EXCEPT the sender
    FOR v_token_record IN 
        SELECT DISTINCT upt.token 
        FROM public.user_push_tokens upt
        JOIN public.conversation_status cs ON cs.user_id = upt.user_id
        WHERE cs.conversation_id = NEW.conversation_id 
          AND cs.user_id != NEW.sender_id
    LOOP
        BEGIN
            -- Direct call to pg_net's http_post with anon key header
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
