-- CONSOLIDATED MIGRATION: Save Chat Feature
-- 1. DROP and Re-create for clean slate (Fixes "column does not exist")
DROP TABLE IF EXISTS public.message_saves CASCADE;

CREATE TABLE public.message_saves (
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    message_id UUID REFERENCES public.messages(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES public.conversations(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, message_id)
);

-- 2. Index for quick lookup
CREATE INDEX IF NOT EXISTS idx_message_saves_user ON public.message_saves(user_id);
CREATE INDEX IF NOT EXISTS idx_message_saves_conv ON public.message_saves(conversation_id);

-- 3. RLS
ALTER TABLE public.message_saves ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own saved messages" ON public.message_saves;
DROP POLICY IF EXISTS "Participants can view saved messages" ON public.message_saves;
DROP POLICY IF EXISTS "Users can insert their own saves" ON public.message_saves;
DROP POLICY IF EXISTS "Users can delete their own saves" ON public.message_saves;

CREATE POLICY "Participants can view saved messages"
    ON public.message_saves
    FOR SELECT
    TO authenticated
    USING (
        auth.uid() = user_id OR 
        EXISTS (
            SELECT 1 FROM public.conversation_status
            WHERE conversation_id = message_saves.conversation_id
            AND user_id = auth.uid()
        )
    );

CREATE POLICY "Users can insert their own saves"
    ON public.message_saves
    FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own saves"
    ON public.message_saves
    FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);

-- 4. RPC functions for saving/unsaving
CREATE OR REPLACE FUNCTION public.save_message(_msg_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_conv_id UUID;
BEGIN
    SELECT conversation_id INTO v_conv_id FROM public.messages WHERE id = _msg_id;
    INSERT INTO public.message_saves (user_id, message_id, conversation_id)
    VALUES (auth.uid(), _msg_id, v_conv_id)
    ON CONFLICT (user_id, message_id) DO NOTHING;
END $$;

CREATE OR REPLACE FUNCTION public.unsave_message(_msg_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    DELETE FROM public.message_saves
    WHERE user_id = auth.uid() AND message_id = _msg_id;
END $$;

-- 5. Protection from purging
CREATE OR REPLACE FUNCTION public.purge_expired_messages()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM messages 
  WHERE expires_at IS NOT NULL 
    AND expires_at < NOW()
    AND id NOT IN (SELECT message_id FROM message_saves);
END;
$$;

CREATE OR REPLACE FUNCTION public.purge_conversation(_conv UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.messages 
  WHERE conversation_id = _conv 
    AND id NOT IN (SELECT message_id FROM message_saves);
    
  IF NOT EXISTS (SELECT 1 FROM public.messages WHERE conversation_id = _conv) THEN
    DELETE FROM public.conversation_status WHERE conversation_id = _conv;
    DELETE FROM public.conversations WHERE id = _conv;
  END IF;
END $$;
