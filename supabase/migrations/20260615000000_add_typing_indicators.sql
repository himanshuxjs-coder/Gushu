-- Typing status table for real-time typing indicators
CREATE TABLE public.typing_status (
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  typing_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.typing_status TO authenticated;
GRANT ALL ON public.typing_status TO service_role;

ALTER TABLE public.typing_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY "participants read typing status" ON public.typing_status FOR SELECT TO authenticated
  USING (public.is_conversation_participant(conversation_id, auth.uid()));

CREATE POLICY "users update own typing status" ON public.typing_status FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.is_conversation_participant(conversation_id, auth.uid()));

CREATE POLICY "users update own typing status on update" ON public.typing_status FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND public.is_conversation_participant(conversation_id, auth.uid()))
  WITH CHECK (user_id = auth.uid() AND public.is_conversation_participant(conversation_id, auth.uid()));

CREATE POLICY "users delete own typing status" ON public.typing_status FOR DELETE TO authenticated
  USING (user_id = auth.uid() AND public.is_conversation_participant(conversation_id, auth.uid()));

CREATE INDEX typing_status_user_idx ON public.typing_status(user_id);
CREATE INDEX typing_status_conv_idx ON public.typing_status(conversation_id);

-- Add to realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE public.typing_status;
ALTER TABLE public.typing_status REPLICA IDENTITY FULL;

-- Update profiles table to add typing_at field for global typing tracking
ALTER TABLE public.profiles ADD COLUMN typing_at TIMESTAMPTZ;

-- Note: Heartbeat interval is controlled by app code
-- The app updates last_seen_at every 1 second for real-time active status display
