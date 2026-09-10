-- Wantok Ride — post-deployment health check.
--
-- Read-only. Safe to run against production, at any time, as often as you like.
-- It writes nothing and locks nothing.
--
-- Paste into the SQL Editor after deploying. Every row comes back PASS, WARN
-- or FAIL with the actual number next to it, so "it seemed to work" becomes a
-- list you can read in ten seconds.
--
-- WARN means the schema is sound but something operational is not switched on
-- yet — an extension, a Vault secret, the scheduler. Those are dashboard
-- settings, not code, and the product runs without them in a reduced form.
-- FAIL means the deployment did not complete and should be re-run.

with

-- Counts that must not be parsed unless the object exists. `query_to_xml`
-- takes its query as text, so the planner never sees `cron.job` or
-- `vault.decrypted_secrets` on a project where they are absent.
cron_jobs as (
  select case when exists (select 1 from pg_extension where extname = 'pg_cron')
    then (xpath('/table/row/n/text()', query_to_xml(
      $q$select count(*) as n from cron.job
          where jobname in ('suspend-expired-documents','document-expiry-warnings',
                            'mark-stale-drivers-offline','scheduled-booking-cycle',
                            'weekly-owner-statements','purge-expired-data')$q$,
      false, true, '')))[1]::text::int
  end as n
),

vault_secrets as (
  select case when to_regclass('vault.decrypted_secrets') is not null
    then (xpath('/table/row/n/text()', query_to_xml(
      $q$select count(*) as n from vault.decrypted_secrets
          where name in ('project_url','service_role_key')$q$,
      false, true, '')))[1]::text::int
  end as n
),

checks as (

  -- --- Structure ------------------------------------------------------

  select 1 as seq, 'Tables created' as item,
         (select count(*) from pg_tables where schemaname = 'public')::text as found,
         '23' as expected,
         case when (select count(*) from pg_tables where schemaname = 'public') >= 23
              then 'PASS' else 'FAIL' end as status

  union all
  select 2, 'Row-level security enabled on every table',
         (select count(*)::text from pg_tables
           where schemaname = 'public' and rowsecurity)::text,
         'all of them',
         case when (select count(*) from pg_tables
                     where schemaname = 'public' and not rowsecurity) = 0
              then 'PASS' else 'FAIL' end

  union all
  -- Named explicitly: a table holding licence numbers, NID numbers or live
  -- positions with RLS off is a data breach waiting for someone with a REST
  -- client, not a tidiness issue.
  select 3, 'RLS on the sensitive tables',
         coalesce((select string_agg(tablename, ', ') from pg_tables
                    where schemaname = 'public' and not rowsecurity
                      and tablename in ('profiles','drivers','owners','bookings',
                                        'ledger_entries','sos_events','driver_status',
                                        'messages','payments')), 'none unprotected'),
         'none unprotected',
         case when (select count(*) from pg_tables
                     where schemaname = 'public' and not rowsecurity
                       and tablename in ('profiles','drivers','owners','bookings',
                                         'ledger_entries','sos_events','driver_status',
                                         'messages','payments')) = 0
              then 'PASS' else 'FAIL' end

  union all
  select 4, 'RLS policies',
         (select count(*) from pg_policies where schemaname = 'public')::text,
         '50',
         case when (select count(*) from pg_policies where schemaname = 'public') >= 50
              then 'PASS' else 'FAIL' end

  -- --- The rules that protect the money -------------------------------

  union all
  select 10, 'Ledger triggers (balance is derived, never written)',
         (select count(*) from pg_trigger
           where tgrelid = 'ledger_entries'::regclass and not tgisinternal)::text,
         '2',
         case when (select count(*) from pg_trigger
                     where tgrelid = 'ledger_entries'::regclass and not tgisinternal) = 2
              then 'PASS' else 'FAIL' end

  union all
  select 11, 'Rate table is append-only',
         (select count(*) from pg_rules
           where schemaname = 'public' and tablename = 'rate_versions')::text,
         '2 rules',
         case when (select count(*) from pg_rules
                     where schemaname = 'public' and tablename = 'rate_versions') = 2
              then 'PASS' else 'FAIL' end

  union all
  select 12, 'Ledger and SOS records cannot be deleted',
         (select count(*) from pg_rules
           where schemaname = 'public' and tablename in ('ledger_entries', 'sos_events'))::text,
         '2 rules',
         case when (select count(*) from pg_rules
                     where schemaname = 'public'
                       and tablename in ('ledger_entries', 'sos_events')) = 2
              then 'PASS' else 'FAIL' end

  union all
  -- The index that stops a replayed offline sync charging a trip twice, and
  -- which must NOT catch an owner's repeated payments.
  select 13, 'One commission entry per booking',
         (select count(*) from pg_indexes
           where schemaname = 'public'
             and indexname = 'ledger_one_commission_per_booking')::text,
         '1',
         case when (select count(*) from pg_indexes
                     where schemaname = 'public'
                       and indexname = 'ledger_one_commission_per_booking') = 1
              then 'PASS' else 'FAIL' end

  union all
  select 14, 'Approval gate trigger',
         (select count(*) from pg_trigger
           where tgrelid = 'vehicles'::regclass and tgname = 'vehicles_guard_approval')::text,
         '1',
         case when (select count(*) from pg_trigger
                     where tgrelid = 'vehicles'::regclass
                       and tgname = 'vehicles_guard_approval') = 1
              then 'PASS' else 'FAIL' end

  union all
  select 15, 'Booking triggers (commission, conduct records)',
         (select count(*) from pg_trigger
           where tgrelid = 'bookings'::regclass and not tgisinternal)::text,
         '2',
         case when (select count(*) from pg_trigger
                     where tgrelid = 'bookings'::regclass and not tgisinternal) >= 2
              then 'PASS' else 'FAIL' end

  union all
  select 16, 'Contact-details view (numbers unlock only on a live booking)',
         (select count(*) from pg_views
           where schemaname = 'public' and viewname = 'booking_contacts')::text,
         '1',
         case when (select count(*) from pg_views
                     where schemaname = 'public' and viewname = 'booking_contacts') = 1
              then 'PASS' else 'FAIL' end

  union all
  select 17, 'Customer vehicle list view',
         (select count(*) from pg_views
           where schemaname = 'public' and viewname = 'listable_vehicles')::text,
         '1',
         case when (select count(*) from pg_views
                     where schemaname = 'public' and viewname = 'listable_vehicles') = 1
              then 'PASS' else 'FAIL' end

  -- --- Realtime -------------------------------------------------------
  --
  -- The silent failure. A subscription to an unpublished table reports itself
  -- SUBSCRIBED and then never fires, so the map simply never moves and nothing
  -- anywhere logs an error.

  union all
  select 20, 'Realtime publication members',
         coalesce((select string_agg(tablename, ', ' order by tablename)
                    from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public'), 'NONE'),
         'bookings, driver_status, messages, sos_events',
         case when (select count(*) from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public'
                       and tablename in ('bookings','driver_status','messages','sos_events')) = 4
              then 'PASS' else 'FAIL' end

  union all
  -- Without this, the driver app's filter on driver_id never matches.
  select 21, 'Bookings replica identity (so non-PK filters work)',
         (select relreplident::text from pg_class where relname = 'bookings'),
         'f (full)',
         case when (select relreplident from pg_class where relname = 'bookings') = 'f'
              then 'PASS' else 'FAIL' end

  -- --- Storage --------------------------------------------------------

  union all
  select 30, 'Storage buckets',
         (select count(*) from storage.buckets
           where id in ('vehicle-photos','documents','receipts','avatars'))::text,
         '4',
         case when (select count(*) from storage.buckets
                     where id in ('vehicle-photos','documents','receipts','avatars')) = 4
              then 'PASS' else 'FAIL' end

  union all
  -- Licences and NID numbers must never be publicly addressable (spec §16).
  select 31, 'Every bucket is private',
         coalesce((select string_agg(id, ', ') from storage.buckets where public), 'all private'),
         'all private',
         case when (select count(*) from storage.buckets where public
                     and id in ('vehicle-photos','documents','receipts','avatars')) = 0
              then 'PASS' else 'FAIL' end

  -- --- Data -----------------------------------------------------------

  union all
  select 40, 'Vehicle classes seeded',
         (select count(*) from vehicle_classes where active)::text,
         '4',
         case when (select count(*) from vehicle_classes where active) = 4
              then 'PASS' else 'FAIL' end

  union all
  select 41, 'Every active class has a rate in force',
         (select count(*)::text from vehicle_classes c
           where c.active and exists (
             select 1 from rate_versions r
              where r.class_code = c.code and r.effective_from <= now())),
         '4',
         case when (select count(*) from vehicle_classes c
                     where c.active and exists (
                       select 1 from rate_versions r
                        where r.class_code = c.code and r.effective_from <= now())) = 4
              then 'PASS' else 'FAIL' end

  -- --- Operational: switches, not code --------------------------------

  union all
  select 50, 'pg_cron enabled',
         case when exists (select 1 from pg_extension where extname = 'pg_cron')
              then 'yes' else 'NOT ENABLED' end,
         'yes',
         case when exists (select 1 from pg_extension where extname = 'pg_cron')
              then 'PASS' else 'WARN' end

  union all
  select 51, 'pg_net enabled',
         case when exists (select 1 from pg_extension where extname = 'pg_net')
              then 'yes' else 'NOT ENABLED' end,
         'yes',
         case when exists (select 1 from pg_extension where extname = 'pg_net')
              then 'PASS' else 'WARN' end

  union all
  -- `cron.job` is referenced as a *string*, executed through query_to_xml.
  --
  -- Writing `from cron.job` directly would be resolved by the parser before
  -- the CASE could guard it, so the whole health check would error out on any
  -- project where pg_cron is not enabled — precisely the situation this row
  -- exists to report.
  select 52, 'Scheduled jobs',
         coalesce((select n from cron_jobs)::text, 'pg_cron not enabled'),
         '6',
         case when (select n from cron_jobs) = 6 then 'PASS' else 'WARN' end

  union all
  -- Without these the cron jobs run but cannot reach the edge functions, so
  -- reminders and statements are computed and then go nowhere. Same dynamic
  -- treatment: the Vault schema is not present on a plain Postgres.
  select 53, 'Vault secrets for the cron jobs',
         coalesce((select n from vault_secrets)::text || ' of 2 set', 'vault not available'),
         'project_url, service_role_key',
         case when (select n from vault_secrets) = 2 then 'PASS' else 'WARN' end
)

select
  case status when 'PASS' then '✓' when 'WARN' then '!' else '✗' end as ok,
  status,
  item as "check",
  found,
  expected
from checks
order by
  -- Anything wrong comes to the top. On a healthy deployment the order is
  -- structural, then realtime, then the operational switches.
  case status when 'FAIL' then 0 when 'WARN' then 1 else 2 end,
  seq;
