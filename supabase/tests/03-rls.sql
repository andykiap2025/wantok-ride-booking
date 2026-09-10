-- Row-level security tests.
--
-- These exist because 01-behaviour.sql does not test RLS at all, and that was
-- not obvious until a policy failed in production that every local test had
-- passed. The reason is simple and worth writing down: those tests run as
-- `postgres`, and a superuser bypasses row-level security completely. Every
-- policy in the schema could have been `using (true)` and they would still
-- have gone green.
--
-- So everything here runs under `set local role`, as the roles the apps
-- actually connect as, with `request.jwt.claim.sub` set to whichever user is
-- being impersonated — which is what `auth.uid()` reads.
--
-- What it is really guarding is one sentence from spec §16: the platform
-- holds driver's licence numbers, national ID numbers and the live location
-- of people in cars, and RLS is the only thing between that and anyone with
-- the anon key and a REST client.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

create or replace function assert_eq(what text, got anyelement, want anyelement)
returns void language plpgsql as $$
begin
  if got is distinct from want then
    raise exception 'FAIL: % — expected %, got %', what, want, got;
  end if;
  raise notice 'PASS  %  (%)', what, got;
end $$;

/**
 * Count rows a given role can actually see.
 *
 * Runs the count inside a sub-transaction as that role, so the surrounding
 * script keeps its own privileges. `request.jwt.claim.sub` is what auth.uid()
 * reads, so setting it is how a specific signed-in user is impersonated.
 */
create or replace function visible_to(as_role text, as_user uuid, target text)
returns integer language plpgsql as $$
declare
  n integer;
begin
  execute format('set local role %I', as_role);
  perform set_config('request.jwt.claim.sub', coalesce(as_user::text, ''), true);
  execute format('select count(*) from %I', target) into n;
  reset role;
  return n;
exception when insufficient_privilege then
  reset role;
  return -1;  -- no GRANT at all, which is a different failure from RLS denying
end $$;

-- ---------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),   -- driver + owner
  ('22222222-2222-2222-2222-222222222222'),   -- customer A
  ('33333333-3333-3333-3333-333333333333'),   -- customer B, unrelated
  ('44444444-4444-4444-4444-444444444444');   -- admin

insert into profiles (id, phone, full_name, role, emergency_contact_name,
                      emergency_contact_phone, emergency_verified_at) values
  ('11111111-1111-1111-1111-111111111111','+67574128860','Joe Kaupa',
   array['DRIVER','OWNER']::user_role[],'Rita','+67571110000', now()),
  ('22222222-2222-2222-2222-222222222222','+67572220000','Dennis Warupi',
   array['CUSTOMER']::user_role[],'Anna','+67573330000', now()),
  ('33333333-3333-3333-3333-333333333333','+67572220001','Mary Sori',
   array['CUSTOMER']::user_role[],'Paul','+67573330001', now()),
  ('44444444-4444-4444-4444-444444444444','+67579990000','Skyworks Admin',
   array['ADMIN','SUPER_ADMIN']::user_role[],'Ops','+67579991111', now());

insert into owners (id, profile_id, nid_number, address)
values ('aaaaaaaa-0000-0000-0000-000000000001',
        '11111111-1111-1111-1111-111111111111','NID-SECRET','Gerehu');

insert into drivers (id, profile_id, licence_number, licence_class, licence_expiry)
values ('bbbbbbbb-0000-0000-0000-000000000001',
        '11111111-1111-1111-1111-111111111111','LICENCE-SECRET','C', current_date + 400);

insert into vehicle_classes (code, name, seats) values ('SEDAN','Small sedan',4);

insert into rate_versions (id, class_code, base_fare, per_km, minimum_fare,
                           night_multiplier, night_start, night_end, rounding,
                           service_fee, commission_pct, effective_from)
values ('cccccccc-0000-0000-0000-000000000001','SEDAN',1000,350,2000,1.30,
        '20:00','05:00',5,0,10.00, now() - interval '30 days');

insert into vehicles (id, owner_id, driver_id, class_code, make, model, year, colour,
                      registration_no, seats, status, rego_expiry, insurance_expiry)
values ('dddddddd-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000001','SEDAN','Toyota','Camry',2019,'White',
        'BEK-472',4,'APPROVED', current_date + 300, current_date + 200);

-- Customer A's trip. Customer B must never see any part of it.
insert into bookings (id, reference, customer_id, vehicle_id, driver_id, state,
                      pickup_lat, pickup_lng, pickup_label, dest_lat, dest_lng, dest_label,
                      distance_km, rate_version_id, quoted_fare, commission_amount,
                      requested_at, confirmed_at, completed_at)
values ('eeeeeeee-0000-0000-0000-000000000001','WR-RLS001',
        '22222222-2222-2222-2222-222222222222','dddddddd-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000001','COMPLETED',
        -9.46,147.18,'Boroko',-9.44,147.21,'Airport',
        6.0,'cccccccc-0000-0000-0000-000000000001',3500,350,
        now() - interval '2 hours', now() - interval '2 hours', now() - interval '1 hour');

insert into messages (booking_id, sender_id, body)
values ('eeeeeeee-0000-0000-0000-000000000001',
        '22222222-2222-2222-2222-222222222222','I am at the gate');

-- =====================================================================
-- Anonymous
-- =====================================================================
--
-- `anon` holds a table-level SELECT grant on everything, so from here on RLS
-- is the only thing standing between a public API key and this data.

select assert_eq('anon can read vehicle classes (needed to show prices)',
  visible_to('anon', null, 'vehicle_classes'), 1);

select assert_eq('anon can read live rates (needed to quote)',
  visible_to('anon', null, 'rate_versions'), 1);

select assert_eq('anon cannot read profiles',        visible_to('anon', null, 'profiles'), 0);
select assert_eq('anon cannot read driver licences', visible_to('anon', null, 'drivers'), 0);
select assert_eq('anon cannot read owner NIDs',      visible_to('anon', null, 'owners'), 0);
select assert_eq('anon cannot read bookings',        visible_to('anon', null, 'bookings'), 0);
select assert_eq('anon cannot read the ledger',      visible_to('anon', null, 'ledger_entries'), 0);
select assert_eq('anon cannot read SOS events',      visible_to('anon', null, 'sos_events'), 0);
select assert_eq('anon cannot read messages',        visible_to('anon', null, 'messages'), 0);
select assert_eq('anon cannot read the audit log',   visible_to('anon', null, 'audit_log'), 0);
select assert_eq('anon cannot read the SMS log',     visible_to('anon', null, 'sms_log'), 0);

-- The one that failed in production. A policy that queries its own table
-- recurses and 500s, which is not a denial — it is an outage.
select assert_eq('anon reading reviews does not recurse',
  visible_to('anon', null, 'reviews'), 0);

-- =====================================================================
-- A signed-in customer
-- =====================================================================

select assert_eq('a customer sees their own booking',
  visible_to('authenticated', '22222222-2222-2222-2222-222222222222', 'bookings'), 1);

select assert_eq('a customer does NOT see another customer''s booking',
  visible_to('authenticated', '33333333-3333-3333-3333-333333333333', 'bookings'), 0);

select assert_eq('a customer does not see another customer''s messages',
  visible_to('authenticated', '33333333-3333-3333-3333-333333333333', 'messages'), 0);

-- Licence numbers and NID numbers are the platform's most sensitive holdings.
select assert_eq('a customer cannot read driver licence records',
  visible_to('authenticated', '22222222-2222-2222-2222-222222222222', 'drivers'), 0);

select assert_eq('a customer cannot read owner NID and bank details',
  visible_to('authenticated', '22222222-2222-2222-2222-222222222222', 'owners'), 0);

select assert_eq('a customer cannot read the commission ledger',
  visible_to('authenticated', '22222222-2222-2222-2222-222222222222', 'ledger_entries'), 0);

select assert_eq('a customer cannot read the audit log',
  visible_to('authenticated', '22222222-2222-2222-2222-222222222222', 'audit_log'), 0);

-- Spec §10: the other party is never told an SOS was triggered.
select assert_eq('a customer cannot read SOS events',
  visible_to('authenticated', '22222222-2222-2222-2222-222222222222', 'sos_events'), 0);

-- =====================================================================
-- The driver and owner
-- =====================================================================

select assert_eq('a driver sees the booking for their vehicle',
  visible_to('authenticated', '11111111-1111-1111-1111-111111111111', 'bookings'), 1);

select assert_eq('an owner sees their own vehicle',
  visible_to('authenticated', '11111111-1111-1111-1111-111111111111', 'vehicles'), 1);

select assert_eq('an owner sees their own NID record',
  visible_to('authenticated', '11111111-1111-1111-1111-111111111111', 'owners'), 1);

-- =====================================================================
-- Admin
-- =====================================================================

select assert_eq('an admin sees every booking',
  visible_to('authenticated', '44444444-4444-4444-4444-444444444444', 'bookings'), 1);

select assert_eq('an admin sees the audit log',
  visible_to('authenticated', '44444444-4444-4444-4444-444444444444', 'audit_log'),
  (select count(*)::int from audit_log));

select assert_eq('an admin sees driver licence records',
  visible_to('authenticated', '44444444-4444-4444-4444-444444444444', 'drivers'), 1);

-- =====================================================================
-- The review blind window (spec §9)
-- =====================================================================
--
-- Neither side sees the other's rating until both have submitted or 48 hours
-- have passed. Enforced by policy, so reading the REST endpoint directly
-- cannot beat it.

-- The trip completed an hour ago, and only the customer has reviewed.
insert into reviews (booking_id, author_id, subject_type, subject_id, stars)
values ('eeeeeeee-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222',
        'VEHICLE','dddddddd-0000-0000-0000-000000000001', 2);

select assert_eq('the author always sees their own review',
  visible_to('authenticated', '22222222-2222-2222-2222-222222222222', 'reviews'), 1);

select assert_eq('the driver cannot see it while the window is blind',
  visible_to('authenticated', '11111111-1111-1111-1111-111111111111', 'reviews'), 0);

-- Now the driver reviews too. Both sides in, so it unblinds.
insert into reviews (booking_id, author_id, subject_type, subject_id, stars)
values ('eeeeeeee-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
        'CUSTOMER','22222222-2222-2222-2222-222222222222', 5);

select assert_eq('both sides in unblinds the reviews',
  visible_to('authenticated', '11111111-1111-1111-1111-111111111111', 'reviews'), 2);

-- And the 48-hour escape hatch, on a booking only one side ever reviewed.
insert into bookings (id, reference, customer_id, vehicle_id, driver_id, state,
                      pickup_lat, pickup_lng, pickup_label, dest_lat, dest_lng, dest_label,
                      distance_km, rate_version_id, quoted_fare, commission_amount,
                      requested_at, confirmed_at, completed_at)
values ('eeeeeeee-0000-0000-0000-000000000002','WR-RLS002',
        '22222222-2222-2222-2222-222222222222','dddddddd-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000001','COMPLETED',
        -9.46,147.18,'A',-9.44,147.21,'B',
        6.0,'cccccccc-0000-0000-0000-000000000001',3500,350,
        now() - interval '5 days', now() - interval '5 days', now() - interval '3 days');

insert into reviews (booking_id, author_id, subject_type, subject_id, stars)
values ('eeeeeeee-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222',
        'VEHICLE','dddddddd-0000-0000-0000-000000000001', 1);

select assert_eq('a review older than 48 hours unblinds even one-sided',
  visible_to('authenticated', '11111111-1111-1111-1111-111111111111', 'reviews'), 3);

-- A hidden review leaves the average and stays out of sight.
update reviews set visible = false
where booking_id = 'eeeeeeee-0000-0000-0000-000000000002';

select assert_eq('a hidden review is invisible even to its author',
  visible_to('authenticated', '22222222-2222-2222-2222-222222222222', 'reviews'), 2);

\echo ''
\echo 'All RLS tests passed.'
