/*
# Cron calls purge SQL function directly (Option C)

## Problem
The previous pg_cron job (migration 20260718150000) tried to HTTP POST to the
`purge-disappearing-messages` edge function using a service role key stored in
a database-level GUC (`app.supabase_service_role_key`). That GUC was never
populated because `current_setting('SUPABASE_SERVICE_ROLE_KEY', true)` returns
NULL in the SQL migration execution context, and the ALTER DATABASE was
silently caught by an EXCEPTION block. As a result the cron job returned early
on every run and never purged anything.

## Solution
Switch the pg_cron job to call `purge_expired_disappearing_messages()` DIRECTLY
via SQL. The cron job already runs inside the database with privileged access,
so no service role key or HTTP call is needed. To preserve storage cleanup
(which was previously the edge function's only responsibility), the purge
function is extended to delete matching objects from the `storage.objects`
table for the `chat-media` bucket directly.

## Changes
1. Unschedule the existing HTTP-based `purge_disappearing_messages_job`.
2. Replace `purge_expired_disappearing_messages()` so it also removes
   `chat-media` storage objects for the purged messages' media paths
   (only when media_path is non-null). Function remains SECURITY DEFINER,
   owned by postgres, returns jsonb. Return type unchanged so no DROP needed.
3. Schedule a new SQL-based cron job that runs `SELECT public.purge_expired_disappearing_messages();` every minute.

## Security
- No new RLS policies. The purge function is SECURITY DEFINER owned by postgres.
- The cron job runs inside the database; no external HTTP call, no secret needed.
- Storage object deletion is performed by the SECURITY DEFINER function which
  bypasses RLS, matching the previous edge-function behavior.

## Notes
- The edge function `purge-disappearing-messages` remains deployed but is no
  longer invoked by the cron job. It can still be called manually if needed.
- Idempotent: unschedule + schedule is safe to re-run.
*/

-- 1. Unschedule any existing job with this name (idempotent).
DO $$
BEGIN
  PERFORM cron.unschedule('purge_disappearing_messages_job');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'unschedule skipped: %', SQLERRM;
END $$;

-- 2. Replace the purge function to also clean up storage objects directly.
--    Return type unchanged (jsonb), so CREATE OR REPLACE is safe.
CREATE OR REPLACE FUNCTION public.purge_expired_disappearing_messages()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  result jsonb;
BEGIN
  -- Collect up to 500 messages whose delete_after has passed and that are
  -- still unsaved and not yet soft-deleted. Snapshot ids + media paths
  -- into a temp table BEFORE deleting so we can clean storage afterwards.
  CREATE TEMP TABLE _purge_targets ON COMMIT DROP AS
    SELECT
      m.id AS message_id,
      m.conversation_id,
      m.media_path
    FROM public.messages m
    WHERE m.delete_after IS NOT NULL
      AND m.delete_after <= now()
      AND m.is_saved = false
      AND m.deleted_at IS NULL
    ORDER BY m.delete_after ASC
    LIMIT 500;

  IF NOT EXISTS (SELECT 1 FROM _purge_targets) THEN
    RETURN '[]'::jsonb;
  END IF;

  -- Cascade-delete all dependent rows first
  DELETE FROM public.message_reactions r USING _purge_targets t WHERE r.message_id = t.message_id;
  DELETE FROM public.message_saves s USING _purge_targets t WHERE s.message_id = t.message_id;
  DELETE FROM public.message_deletions d USING _purge_targets t WHERE d.message_id = t.message_id;
  DELETE FROM public.message_user_views v USING _purge_targets t WHERE v.message_id = t.message_id;
  DELETE FROM public.message_clear_exemptions e USING _purge_targets t WHERE e.message_id = t.message_id;

  -- Clean up storage objects in the chat-media bucket for messages that had media.
  -- The media_path is stored as "{conversation_id}/{message_id}.{ext}".
  DELETE FROM storage.objects o
  USING _purge_targets t
  WHERE o.bucket_id = 'chat-media'
    AND o.name = t.media_path
    AND t.media_path IS NOT NULL;

  -- Soft-delete then hard-delete messages
  UPDATE public.messages m SET deleted_at = now()
  FROM _purge_targets t WHERE m.id = t.message_id;

  DELETE FROM public.messages m USING _purge_targets t WHERE m.id = t.message_id;

  -- Build per-conversation summary for caller (edge function)
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'conversation_id', t.conversation_id,
        'message_ids', t.message_ids,
        'media_paths', t.media_paths
      )
    ), '[]'::jsonb
  ) INTO result
  FROM (
    SELECT conversation_id,
      jsonb_agg(message_id) AS message_ids,
      jsonb_agg(media_path) AS media_paths
    FROM _purge_targets
    GROUP BY conversation_id
  ) t;

  RETURN result;
END;
$function$;

-- 3. Schedule the job to call the purge function directly via SQL.
SELECT cron.schedule(
  'purge_disappearing_messages_job',
  '* * * * *',
  $cron$
    SELECT public.purge_expired_disappearing_messages();
  $cron$
);
