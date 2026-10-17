-- The table may predate the registration RPC and therefore lack its
-- required uniqueness constraint. Remove duplicate legacy rows first.
DELETE FROM public.user_push_tokens duplicate_row
USING public.user_push_tokens retained_row
WHERE duplicate_row.user_id = retained_row.user_id
  AND duplicate_row.token = retained_row.token
  AND duplicate_row.id > retained_row.id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.user_push_tokens'::regclass
      AND conname = 'user_push_tokens_user_id_token_key'
  ) THEN
    ALTER TABLE public.user_push_tokens
      ADD CONSTRAINT user_push_tokens_user_id_token_key UNIQUE (user_id, token);
  END IF;
END;
$$;