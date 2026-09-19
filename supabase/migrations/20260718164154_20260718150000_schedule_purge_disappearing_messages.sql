/*
# Schedule purge-disappearing-messages edge function via pg_cron

1. Purpose
   - Calls the `purge-disappearing-messages` edge function every 1 minute so
     expired disappearing messages are purged from the database and their
     storage objects removed, without relying on any external scheduler.
   - The edge function authorizes the caller by comparing the `Authorization`
     header to `Bearer <SUPABASE_SERVICE_ROLE_KEY>`. We pass that header from
     pg_cron via `pg_net`'s `net.http_post`.

2. Extensions
   - Ensures `pg_cron` is enabled (Supabase-managed extension).
   - Ensures `pg_net` is enabled (used to make the outbound HTTP POST).

3. Scheduled job
   - Name: `purge_disappearing_messages_job`
   - Schedule: `* * * * *` (every minute)
   - Action: `SELECT net.http_post(...)` against the edge function URL with the
     service role Bearer token read from the `app.supabase_service_role_key` GUC.

4. Idempotency
   - Uses `CREATE EXTENSION IF NOT EXISTS`.
   - The cron job is unscheduled first with `cron.unschedule(job_name)` if it
     already exists, then rescheduled. Safe to re-run.

5. Security
   - The service role key is never written into the migration SQL as a literal.
   - The GUC is set per-database via `ALTER DATABASE ... SET ...` reading the
     env var that Supabase injects into the Postgres process. If the env var
     is not visible inside this migration, an admin can set it manually via
     `ALTER DATABASE <db> SET app.supabase_service_role_key = '<value>';`
*/

-- 1. Ensure required extensions
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- 2. Expose the service role key to SQL via a database-level GUC.
--    Supabase injects SUPABASE_SERVICE_ROLE_KEY into the Postgres process env.
DO $$
BEGIN
  BEGIN
    EXECUTE format(
      'ALTER DATABASE %I SET app.supabase_service_role_key = %L',
      current_database(),
      COALESCE(current_setting('SUPABASE_SERVICE_ROLE_KEY', true), '')
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Could not auto-set app.supabase_service_role_key GUC from env: %', SQLERRM;
  END;
END $$;

-- 3. Unschedule any existing job with this name (idempotent), then reschedule.
DO $$
BEGIN
  PERFORM cron.unschedule('purge_disappearing_messages_job');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'unschedule skipped: %', SQLERRM;
END $$;

-- 4. Schedule the job. We build the URL from the SUPABASE_URL env var and pass
--    the service role key from the GUC. The job body no-ops if the GUC is empty
--    (keeps the job healthy even before the key is set).
SELECT cron.schedule(
  'purge_disappearing_messages_job',
  '* * * * *',
  $cron$
    DO $$
    DECLARE
      _key text := current_setting('app.supabase_service_role_key', true);
      _base_url text := current_setting('SUPABASE_URL', true);
    BEGIN
      IF _key IS NULL OR _key = '' OR _base_url IS NULL OR _base_url = '' THEN
        RETURN;
      END IF;
      PERFORM net.http_post(
        url := _base_url || '/functions/v1/purge-disappearing-messages',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || _key,
          'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb
      );
    END $$;
  $cron$
);
