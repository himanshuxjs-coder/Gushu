-- Enable live Supabase Realtime for the tables used by the chat UI
DO $$
DECLARE
  publication_name text := 'supabase_realtime';
  tbl_name text;
  schema_name text;
  table_name text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication
    WHERE pubname = publication_name
  ) THEN
    RETURN;
  END IF;

  FOREACH tbl_name IN ARRAY ARRAY[
    'public.messages',
    'public.conversations',
    'public.conversation_settings',
    'public.message_reactions',
    'public.message_saves',
    'public.message_deletions',
    'public.profiles'
  ]
  LOOP
    schema_name := split_part(tbl_name, '.', 1);
    table_name := split_part(tbl_name, '.', 2);

    IF to_regclass(format('%I.%I', schema_name, table_name)) IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM pg_publication_tables
         WHERE pubname = publication_name
           AND schemaname = schema_name
           AND tablename = table_name
       ) THEN
      EXECUTE format('ALTER PUBLICATION %I ADD TABLE %I.%I', publication_name, schema_name, table_name);
    END IF;
  END LOOP;
END $$;
