-- Function to notify via push notification
CREATE OR REPLACE FUNCTION public.handle_new_message_notification()
RETURNS TRIGGER AS $$
DECLARE
    recipient_ids UUID[];
    token_record RECORD;
    sender_name TEXT;
    notification_title TEXT;
    notification_body TEXT;
    conv_id UUID;
BEGIN
    conv_id := NEW.conversation_id;

    -- Get recipients (excluding the sender)
    SELECT ARRAY(
        SELECT user_id 
        FROM public.conversation_status 
        WHERE conversation_id = conv_id AND user_id != NEW.sender_id
    ) INTO recipient_ids;

    -- Get sender name
    SELECT COALESCE(display_name, username) INTO sender_name
    FROM public.profiles
    WHERE id = NEW.sender_id;

    notification_title := 'New Message from ' || sender_name;
    notification_body := CASE 
        WHEN NEW.message_type = 'text' THEN NEW.content
        ELSE 'Sent you a ' || NEW.message_type
    END;

    -- For each recipient, get their tokens and call the edge function
    FOR token_record IN (
        SELECT token FROM public.user_push_tokens WHERE user_id = ANY(recipient_ids)
    ) LOOP
        -- Invoke the Supabase Edge Function
        -- Note: You need to replace 'your-project-ref' with your actual project ref in the URL or use a generic approach
        -- Actually, it's better to use net.http_post if extensions are enabled, or a webhook.
        -- In Supabase, we can use the 'supabase_functions' extension if available, or just a generic HTTP call.
        -- For simplicity and robustness, we use a trigger that invokes the function via pg_net or similar if available.
        -- However, a more standard way is to use a Database Webhook in the Supabase Dashboard.
        -- But since I'm providing SQL, I'll use a generic approach or explain it needs to be setup in UI.
        
        -- Fallback: Just log it for now, or use pg_net if installed
        PERFORM net.http_post(
            url := 'https://' || current_setting('request.headers')::json->>'host' || '/functions/v1/push-notifications',
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'Authorization', 'Bearer ' || current_setting('request.jwt.claims')::json->>'role' -- Or a service role key
            ),
            body := jsonb_build_object(
                'tokens', ARRAY[token_record.token],
                'title', notification_title,
                'body', notification_body,
                'data', jsonb_build_object(
                    'conversation_id', conv_id::text
                )
            )
        );
    END LOOP;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger
CREATE TRIGGER on_new_message_push_notification
    AFTER INSERT ON public.messages
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_message_notification();
