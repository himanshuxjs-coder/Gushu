-- Fix push delivery: user_notification_tokens is not part of this schema.
-- Registered native tokens live in user_push_tokens.
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.handle_new_message_push_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  token_record RECORD;
  supabase_url TEXT;
BEGIN
  supabase_url := COALESCE(
    NULLIF(current_setting('SUPABASE_URL', true), ''),
    'https://sixmxaxsvtafvrjewitd.supabase.co'
  );

  FOR token_record IN
    SELECT DISTINCT upt.token, upt.user_id
    FROM public.user_push_tokens AS upt
    JOIN public.conversation_status AS membership
      ON membership.user_id = upt.user_id
    WHERE membership.conversation_id = NEW.conversation_id
      AND membership.user_id <> NEW.sender_id
      AND COALESCE(
        (
          SELECT settings.notification_enabled
          FROM public.conversation_settings AS settings
          WHERE settings.conversation_id = NEW.conversation_id
            AND settings.user_id = upt.user_id
        ),
        true
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.active_conversations AS active_conversation
        WHERE active_conversation.user_id = upt.user_id
          AND active_conversation.conversation_id = NEW.conversation_id
          AND active_conversation.updated_at > now() - interval '60 seconds'
      )
  LOOP
    PERFORM net.http_post(
      url := supabase_url || '/functions/v1/send-push',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := jsonb_build_object(
        'token', token_record.token,
        'title', 'Gushu',
        'body', 'Knock Knock',
        'conversationId', NEW.conversation_id
      )
    );
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_push_notification ON public.messages;
DROP TRIGGER IF EXISTS tg_messages_send_push_notification ON public.messages;
CREATE TRIGGER tg_messages_send_push_notification
AFTER INSERT ON public.messages
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_message_push_notification();

GRANT EXECUTE ON FUNCTION public.handle_new_message_push_notification() TO authenticated, service_role;
