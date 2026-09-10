-- =====================================================================
-- Wantok Ride — Realtime
--
-- Spec §18: "Supabase Realtime for driver positions and booking state."
--
-- Realtime delivers nothing until a table is added to the `supabase_realtime`
-- publication. Without this migration every subscription in the apps and the
-- console connects successfully, reports itself as SUBSCRIBED, and then sits
-- silent forever — which is the worst possible failure mode, because nothing
-- errors and the map simply never moves.
--
-- Row-level security still applies to every message. A passenger subscribed to
-- a booking receives changes only for bookings the policies already let them
-- read, so publishing these tables widens nothing.
-- =====================================================================

-- The publication exists on a managed Supabase project. Creating it here as a
-- fallback keeps `supabase db reset` and the test harness working against a
-- plain cluster.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

/**
 * Add a table to the realtime publication, once.
 *
 * `alter publication ... add table` errors if the table is already a member,
 * so a migration that ran twice would fail. This makes it idempotent.
 */
create or replace function publish_realtime(target regclass)
returns void language plpgsql as $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = target::text
  ) then
    execute format('alter publication supabase_realtime add table %s', target);
  end if;
end $$;

-- --- Booking state ----------------------------------------------------
--
-- The customer's waiting screen, the customer's trip screen, the driver's
-- trip screen and the admin live board all watch this.
select publish_realtime('bookings');

-- The driver app filters incoming requests by `driver_id`, and the console
-- filters by state. Neither column is in the primary key, and Postgres only
-- puts primary-key columns in the WAL record unless told otherwise — so a
-- filtered subscription on anything but `id` would never match.
--
-- The cost is a fatter WAL record per update. For bookings, which change a
-- handful of times per trip, that is a trade worth making to have the filters
-- work at all.
alter table bookings replica identity full;

-- --- Driver positions -------------------------------------------------
--
-- The moving car on the passenger's map while the driver is on the way, and
-- every vehicle on the admin console's live map.
--
-- This is the highest-volume publication in the product: a ping every 15
-- seconds per online driver, every 5 during a trip. `driver_id` is the primary
-- key, so the default replica identity already covers the per-driver filter
-- and there is no reason to pay for `full` here.
select publish_realtime('driver_status');

-- --- Chat --------------------------------------------------------------
select publish_realtime('messages');
alter table messages replica identity full;  -- filtered by booking_id

-- --- SOS ---------------------------------------------------------------
--
-- The console alarms on an INSERT here. It is the one subscription where a
-- missed message is a safety failure rather than a stale screen, which is why
-- `sos-trigger` also sends an SMS to the on-call phone and does not rely on
-- this channel alone.
select publish_realtime('sos_events');

-- Deliberately NOT published:
--
--   booking_locations — the breadcrumb trail, written every 5 seconds during
--     a trip. Publishing it would multiply realtime traffic for data nothing
--     watches live; the console reads the trail on demand.
--   ledger_entries, payments — money moves on a human timescale. The console
--     polls every 30 seconds and that is fast enough.
--   profiles, vehicles, documents — changed rarely, and by an admin who is
--     already looking at the screen that changed.
