ALTER TABLE public.scheduled_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "scheduled_messages_sender_insert" ON public.scheduled_messages;
CREATE POLICY "scheduled_messages_sender_insert"
  ON public.scheduled_messages FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = sender_id
    AND EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_id
        AND auth.uid() IN (c.user1_id, c.user2_id)
    )
  );

DROP POLICY IF EXISTS "scheduled_messages_sender_update" ON public.scheduled_messages;
CREATE POLICY "scheduled_messages_sender_update"
  ON public.scheduled_messages FOR UPDATE TO authenticated
  USING (
    auth.uid() = sender_id
    AND EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_id
        AND auth.uid() IN (c.user1_id, c.user2_id)
    )
  )
  WITH CHECK (auth.uid() = sender_id);

REVOKE EXECUTE ON FUNCTION public.deliver_scheduled_messages() FROM PUBLIC, anon, authenticated;
