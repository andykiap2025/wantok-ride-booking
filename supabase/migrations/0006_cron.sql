-- =====================================================================
-- Wantok Ride — scheduled jobs
--
-- Runs last, because every job here calls a function defined in an earlier
-- migration. `cron.schedule` takes its command as a string and does not
-- validate it, so a job scheduled before its function existed would fail
-- silently at 00:05 rather than loudly at deploy time.
--
-- Times are UTC. Port Moresby is UTC+10 with no daylight saving, so 14:00Z
-- is midnight local and 08:00Z is 18:00 local.
--
-- If pg_cron is not enabled on the project this migration does nothing and
-- says so. It does not fail: the rest of the schema is perfectly usable
-- without the scheduler, and losing the whole deployment over an extension
-- toggle would be a poor trade. Enable it under Database → Extensions and
-- re-run this file.
-- =====================================================================

do $$
declare
  has_cron boolean;
begin
  select exists (select 1 from pg_available_extensions where name = 'pg_cron') into has_cron;

  if not has_cron then
    raise notice 'pg_cron is not available on this project. Skipping the schedule.';
    return;
  end if;

  create extension if not exists pg_cron;

  -- Idempotent: unschedule anything already carrying these names, so this
  -- migration can be re-run without stacking duplicate jobs.
  perform cron.unschedule(jobname)
  from cron.job
  where jobname in (
    'suspend-expired-documents', 'document-expiry-warnings',
    'mark-stale-drivers-offline', 'scheduled-booking-cycle',
    'weekly-owner-statements', 'purge-expired-data'
  );

  -- Document expiry. Runs just after local midnight so a certificate that
  -- expires "today" comes off the road at the start of the day, not the end
  -- of it (spec §6).
  perform cron.schedule(
    'suspend-expired-documents',
    '5 14 * * *',                       -- 00:05 Port Moresby
    'select suspend_expired_documents();'
  );

  -- Expiry warnings at 30, 14 and 7 days. Sent in the morning, when an owner
  -- can actually do something about it.
  perform cron.schedule(
    'document-expiry-warnings',
    '0 22 * * *',                       -- 08:00 Port Moresby
    'select send_document_warnings();'
  );

  -- Presence. A stale pin on the customer's list is the fastest way to lose a
  -- customer, so this runs often (spec §13).
  perform cron.schedule(
    'mark-stale-drivers-offline',
    '*/2 * * * *',
    'select mark_stale_drivers_offline();'
  );

  -- Scheduled bookings: reminders, and the 45-minute release. Every minute,
  -- because "never let a scheduled booking fail silently on the morning" does
  -- not tolerate a coarse schedule.
  perform cron.schedule(
    'scheduled-booking-cycle',
    '* * * * *',
    'select run_scheduled_booking_cycle();'
  );

  -- Weekly owner statements, Monday morning (spec §8).
  perform cron.schedule(
    'weekly-owner-statements',
    '0 21 * * 0',                       -- Monday 07:00 Port Moresby
    'select send_weekly_statements();'
  );

  -- Retention (spec §16): breadcrumbs 90 days, messages 12 months. Financial
  -- records and SOS records are never purged.
  perform cron.schedule(
    'purge-expired-data',
    '30 15 * * 0',                      -- Monday 01:30 Port Moresby
    'select purge_expired_data();'
  );

  raise notice 'Scheduled 6 jobs.';
end $$;
