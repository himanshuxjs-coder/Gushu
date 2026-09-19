-- Update the push notification function with correct URL
CREATE OR REPLACE FUNCTION public.handle_new_message_push_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'net', 'extensions'
AS $function$
DECLARE
    v_supabase_url TEXT;
    v_anon_key TEXT;
    v_token_record RECORD;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RETURN NEW;
    END IF;

    -- Get the anon key from app_settings table
    SELECT value INTO v_anon_key
    FROM public.app_settings
    WHERE key = 'anon_key'
    LIMIT 1;

    -- Construct Supabase URL
    v_supabase_url := 'https://zwenvbkmuqxhszevacyx.supabase.co';

    FOR v_token_record IN
        SELECT DISTINCT upt.token, upt.user_id
        FROM public.user_push_tokens upt
        JOIN public.conversation_status cs
            ON cs.user_id = upt.user_id
        WHERE cs.conversation_id = NEW.conversation_id
          AND cs.user_id <> NEW.sender_id
    LOOP
        -- Skip if user is active in conversation (within 60 seconds)
        IF EXISTS (
            SELECT 1
            FROM public.active_conversations ac
            WHERE ac.user_id = v_token_record.user_id
              AND ac.conversation_id = NEW.conversation_id
              AND ac.updated_at > NOW() - INTERVAL '60 seconds'
        ) THEN
            CONTINUE;
        END IF;

        -- Call the send-push edge function
        IF v_anon_key IS NOT NULL THEN
            PERFORM http_post(
                url := v_supabase_url || '/functions/v1/send-push',
                headers := jsonb_build_object(
                    'Content-Type', 'application/json',
                    'apikey', v_anon_key,
                    'Authorization', 'Bearer ' || v_anon_key
                ),
                body := jsonb_build_object(
                    'token', v_token_record.token,
                    'title', 'Gushu',
                    'body', 'Knock Knock'
                )
            );
        END IF;

    END LOOP;

    RETURN NEW;
END;
$function$;

-- Update the anon key with the correct one
UPDATE public.app_settings 
SET value = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp3ZW52YmttdXF4aHN6ZXZhY3l4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2MzczODEsImV4cCI6MjA5ODIxMzM4MX0.YyfvKYpNrMBENG5Rwoc0hXbjH_KGVrCVSo95_83SnDs', 
    updated_at = NOW()
WHERE key = 'anon_key';