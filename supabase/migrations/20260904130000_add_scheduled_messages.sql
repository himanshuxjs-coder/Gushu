CREATE TABLE IF NOT EXISTS public.scheduled_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content text NOT NULL CHECK (char_length(btrim(content)) BETWEEN 1 AND 4000),
  scheduled_for timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled')),
  sent_message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due
  ON public.scheduled_messages (scheduled_for)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_sender
  ON public.scheduled_messages (sender_id, created_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'scheduled_messages'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.scheduled_messages;
  END IF;
END $$;

ALTER TABLE public.scheduled_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "scheduled_messages_sender_select" ON public.scheduled_messages;
CREATE POLICY "scheduled_messages_sender_select"
  ON public.scheduled_messages FOR SELECT TO authenticated
  USING (auth.uid() = sender_id);

DROP POLICY IF EXISTS "scheduled_messages_sender_insert" ON public.scheduled_messages;
CREATE POLICY "scheduled_messages_sender_insert"
  ON public.scheduled_messages FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = sender_id);

DROP POLICY IF EXISTS "scheduled_messages_sender_update" ON public.scheduled_messages;
CREATE POLICY "scheduled_messages_sender_update"
  ON public.scheduled_messages FOR UPDATE TO authenticated
  USING (auth.uid() = sender_id)
  WITH CHECK (auth.uid() = sender_id);

DROP POLICY IF EXISTS "scheduled_messages_sender_delete" ON public.scheduled_messages;
CREATE POLICY "scheduled_messages_sender_delete"
  ON public.scheduled_messages FOR DELETE TO authenticated
  USING (auth.uid() = sender_id);

CREATE OR REPLACE FUNCTION public.deliver_scheduled_messages()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  scheduled_row record;
  new_message_id uuid;
  delivered_count integer := 0;
BEGIN
  FOR scheduled_row IN
    SELECT sm.*
    FROM public.scheduled_messages sm
    WHERE sm.status = 'pending'
      AND sm.scheduled_for <= now()
    ORDER BY sm.scheduled_for ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 100
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM public.conversations c
      WHERE c.id = scheduled_row.conversation_id
        AND scheduled_row.sender_id IN (c.user1_id, c.user2_id)
    ) THEN
      UPDATE public.scheduled_messages
      SET status = 'cancelled', updated_at = now()
      WHERE id = scheduled_row.id;
      CONTINUE;
    END IF;

    INSERT INTO public.messages (conversation_id, sender_id, content, message_type)
    VALUES (scheduled_row.conversation_id, scheduled_row.sender_id, scheduled_row.content, 'text')
    RETURNING id INTO new_message_id;

    UPDATE public.scheduled_messages
    SET status = 'sent', sent_message_id = new_message_id, updated_at = now()
    WHERE id = scheduled_row.id;

    delivered_count := delivered_count + 1;
  END LOOP;

  RETURN delivered_count;
END;
$function$;

DO $$
BEGIN
  PERFORM cron.unschedule('gushu_deliver_scheduled_messages');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'gushu_deliver_scheduled_messages',
  '* * * * *',
  'SELECT public.deliver_scheduled_messages();'
);
