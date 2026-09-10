-- =====================================================================
-- Wantok Ride — scheduled jobs
--
-- Everything here is a `select` of a function defined in 0002. The schedule
-- lives apart from the logic so it can be changed, paused during the pilot,
-- or run by hand from the console without touching behaviour.
--
-- Times are UTC. Port Moresby is UTC+10 with no daylight saving, so 14:00Z
-- is midnight local and 08:00Z is 18:00 local.
-- =====================================================================

create extension if not exists pg_cron;

-- Document expiry. Runs just after local midnight so a certificate that
-- expires "today" comes off the road at the start of the day, not the end of
-- it (spec §6).
select cron.schedule(
  'suspend-expired-documents',
  '5 14 * * *',                       -- 00:05 Port Moresby
  $$ select suspend_expired_documents(); $$
);

-- Expiry warnings at 30, 14 and 7 days. Sent in the morning, when an owner
-- can actually do something about it.
select cron.schedule(
  'document-expiry-warnings',
  '0 22 * * *',                       -- 08:00 Port Moresby
  $$ select send_document_warnings(); $$
);

-- Presence. A stale pin on the customer's list is the fastest way to lose a
-- customer, so this runs often (spec §13).
select cron.schedule(
  'mark-stale-drivers-offline',
  '*/2 * * * *',
  $$ select mark_stale_drivers_offline(); $$
);

-- Scheduled bookings: reminders, and the 45-minute release. Every minute,
-- because "never let a scheduled booking fail silently on the morning" does
-- not tolerate a coarse schedule.
select cron.schedule(
  'scheduled-booking-cycle',
  '* * * * *',
  $$ select run_scheduled_booking_cycle(); $$
);

-- Weekly owner statements, Monday morning (spec §8).
select cron.schedule(
  'weekly-owner-statements',
  '0 21 * * 0',                       -- Monday 07:00 Port Moresby
  $$ select send_weekly_statements(); $$
);

-- Retention (spec §16): breadcrumbs 90 days, messages 12 months. Financial
-- records and SOS records are never purged.
select cron.schedule(
  'purge-expired-data',
  '30 15 * * 0',                      -- Monday 01:30 Port Moresby
  $$ select purge_expired_data(); $$
);
