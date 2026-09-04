-- Install the http extension for making HTTP requests
CREATE EXTENSION IF NOT EXISTS http;

-- Set the anon key as a database setting (will be set via environment in production)
-- Note: In Supabase, we need to use a different approach since ALTER DATABASE requires superuser
-- We'll set it via the function using pg_net or use the supabase_url construction

-- Create a helper function that constructs the URL and makes the call without needing the setting
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
    v_response JSONB;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RETURN NEW;
    END IF;

    -- Get the anon key from environment or vault
    -- First try vault (if available), then fall back to GUC
    BEGIN
        v_anon_key := NULL;
        -- Try to get from vault if available
        IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'supabase_vault') THEN
            SELECT decrypted_secret INTO v_anon_key
            FROM vault.decrypted_secrets
            WHERE name = 'anon_key'
            LIMIT 1;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        v_anon_key := NULL;
    END;
    
    -- Fall back to GUC setting if vault didn't work
    IF v_anon_key IS NULL THEN
        v_anon_key := current_setting('app.settings.anon_key', true);
    END IF;
    
    -- If still null, use project URL pattern (the anon key is public-safe for client-side use)
    IF v_anon_key IS NULL THEN
        -- Get from app settings table if it exists
        SELECT value INTO v_anon_key
        FROM public.app_settings
        WHERE key = 'anon_key'
        LIMIT 1;
    END IF;

    -- Construct Supabase URL from the database connection
    v_supabase_url := 'https://xzeqhoolzewzojjodzmx.supabase.co';

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

-- Create a table to store app settings if it doesn't exist
CREATE TABLE IF NOT EXISTS public.app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS on app_settings
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- Create policies for app_settings (only service role can manage)
CREATE POLICY "app_settings_select" ON public.app_settings FOR SELECT
    TO anon, authenticated USING (true);

-- Grant permissions
GRANT SELECT ON public.app_settings TO anon, authenticated;

-- Insert the anon key (this is the public anon key from Supabase, safe to store)
INSERT INTO public.app_settings (key, value) 
VALUES ('anon_key', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh6ZXFob29semV3em9qam9kem14Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDY3NjIwMTgsImV4cCI6MjA2MjMzODAxOH0.FZz7YxRgQZ5VK3K0QZJwNtQpL9QqYrH1RJNJkJkK1kI')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

-- Add trigger for updated_at on app_settings
CREATE OR REPLACE FUNCTION public.tg_set_app_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_settings_updated_at ON public.app_settings;
CREATE TRIGGER app_settings_updated_at
    BEFORE UPDATE ON public.app_settings
    FOR EACH ROW
    EXECUTE FUNCTION public.tg_set_app_settings_updated_at();