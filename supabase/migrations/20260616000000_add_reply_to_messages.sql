-- Add reply_to column to messages for threaded replies
ALTER TABLE public.messages ADD COLUMN reply_to UUID NULL REFERENCES public.messages(id) ON DELETE SET NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.messages TO authenticated;
GRANT ALL ON public.messages TO service_role;

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS messages_reply_to_idx ON public.messages(reply_to);

-- Add to realtime publication so replies propagate
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_publication_rel pr
		JOIN pg_class c ON pr.prrelid = c.oid
		JOIN pg_namespace n ON c.relnamespace = n.oid
		JOIN pg_publication p ON pr.prpubid = p.oid
		WHERE p.pubname = 'supabase_realtime' AND n.nspname = 'public' AND c.relname = 'messages'
	) THEN
		EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.messages';
	END IF;
END
$$;
