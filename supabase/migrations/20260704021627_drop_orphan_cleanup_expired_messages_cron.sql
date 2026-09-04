/*
# Remove orphaned cron job referencing a non-existent function

## Problem
A cron job (`gushu-cleanup-expired-messages`, jobid=1) is scheduled every
minute to run `SELECT public.cleanup_expired_messages();`. That function does
NOT exist in the database — only `public.purge_expired_messages()` does, and
it is already covered by a second, working cron job
(`gushu_purge_expired_messages`, jobid=3).

The orphaned job therefore throws `function public.cleanup_expired_messages()
does not exist` once per minute, producing noise in logs and accomplishing
nothing.

## Changes
1. Unschedules (drops) the orphaned cron job `gushu-cleanup-expired-messages`.

## Security
- No table, RLS, or policy changes.
- No user data is touched. This only removes a failing scheduled job.
- The real expiry cleanup continues to run via `gushu_purge_expired_messages`.

## Notes
1. `cron.unschedule` accepts either the jobid or the jobname. We use jobname
   for readability and to target the orphan specifically.
2. Wrapped in a DO block with exception handling so the migration is safe to
   re-run even if the job was already removed.
*/

DO $$
BEGIN
  PERFORM cron.unschedule('gushu-cleanup-expired-messages');
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not unschedule gushu-cleanup-expired-messages: %', SQLERRM;
END
$$;
