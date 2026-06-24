-- 1. Enable REPLICA IDENTITY FULL for these tables
ALTER TABLE public.messages REPLICA IDENTITY FULL;
ALTER TABLE public.conversation_settings REPLICA IDENTITY FULL;

-- 2. Use a DO block to safely add tables to the publication
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Skipping messages publication: %', SQLERRM;
  END;

  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.conversation_settings;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Skipping settings publication: %', SQLERRM;
  END;
END $$;

