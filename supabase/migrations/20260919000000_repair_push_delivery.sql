-- Repair Android push delivery for the Supabase project linked in this repo.
-- Earlier migrations defined this function but never attached it to messages,
-- so sending a message could not invoke the Edge Function.

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.handle_new_message_push_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  token_record RECORD;
BEGIN
  FOR token_record IN
    WITH registered_tokens AS (
      SELECT user_id, token FROM public.user_push_tokens
      UNION
      SELECT user_id, fcm_token AS token FROM public.user_notification_tokens
    )
    SELECT DISTINCT registered_tokens.token, registered_tokens.user_id
    FROM registered_tokens
    JOIN public.conversation_status AS membership
      ON membership.user_id = registered_tokens.user_id
    WHERE membership.conversation_id = NEW.conversation_id
      AND membership.user_id <> NEW.sender_id
      AND COALESCE(
        (
          SELECT settings.notification_enabled
          FROM public.conversation_settings AS settings
          WHERE settings.conversation_id = NEW.conversation_id
            AND settings.user_id = registered_tokens.user_id
        ),
        true
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.active_conversations AS active_conversation
        WHERE active_conversation.user_id = registered_tokens.user_id
          AND active_conversation.conversation_id = NEW.conversation_id
          AND active_conversation.updated_at > now() - interval '60 seconds'
      )
  LOOP
    PERFORM net.http_post(
      url := 'https://sixmxaxsvtafvrjewitd.supabase.co/functions/v1/send-push',
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

-- The trigger must be callable by the role inserting messages. The function
-- itself uses SECURITY DEFINER only to read recipient tokens under RLS.
REVOKE ALL ON FUNCTION public.handle_new_message_push_notification() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.handle_new_message_push_notification() TO authenticated, service_role;
