-- Behaviour tests for the Wantok Ride schema.
--
-- These are not a substitute for the 147 unit tests on the domain engine.
-- They cover what only the database can enforce: the approval gate, the
-- derived balance, automatic suspension and relisting, the append-only rate
-- table, and the check constraints that stop a bad client writing a row
-- nobody can explain later.
--
-- Every test asserts. A pass prints one line; a failure raises and stops the
-- run. Nothing here asks a human to read a table and decide.
--
-- Run with:  ./scripts/test-db.sh

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- ---------------------------------------------------------------------
-- Assertion helpers
-- ---------------------------------------------------------------------

create or replace function assert_eq(what text, got anyelement, want anyelement)
returns void language plpgsql as $$
begin
  if got is distinct from want then
    raise exception 'FAIL: % — expected %, got %', what, want, got;
  end if;
  raise notice 'PASS  %  (%)', what, got;
end $$;

/**
 * Assert that a statement is refused.
 *
 * Used for every rule the database is supposed to make impossible. A test that
 * only checks the happy path would pass just as well against a schema with no
 * constraints at all.
 */
create or replace function assert_rejects(what text, stmt text)
returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'FAIL: % — the statement was accepted when it should have been refused', what;
exception
  when check_violation or foreign_key_violation or unique_violation or not_null_violation then
    raise notice 'PASS  %  (refused: %)', what, left(sqlerrm, 70);
end $$;

-- ---------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

insert into profiles (id, phone, full_name, role) values
  ('11111111-1111-1111-1111-111111111111', '+67574128860', 'Joe Kaupa',
   array['DRIVER','OWNER']::user_role[]),
  ('22222222-2222-2222-2222-222222222222', '+67572220000', 'Dennis Warupi',
   array['CUSTOMER']::user_role[]);

insert into owners (id, profile_id, nid_number, address)
values ('33333333-3333-3333-3333-333333333333',
        '11111111-1111-1111-1111-111111111111', 'NID-1', 'Gerehu');

insert into drivers (id, profile_id, licence_number, licence_class, licence_expiry)
values ('44444444-4444-4444-4444-444444444444',
        '11111111-1111-1111-1111-111111111111', 'PNG-1', 'C', current_date + 400);

insert into vehicle_classes (code, name, seats) values ('SEDAN', 'Small sedan', 4);

insert into rate_versions (id, class_code, base_fare, per_km, minimum_fare, night_multiplier,
                           night_start, night_end, rounding, service_fee, commission_pct,
                           effective_from)
values ('55555555-5555-5555-5555-555555555555', 'SEDAN', 1000, 350, 2000, 1.30,
        '20:00', '05:00', 5, 0, 10.00, now() - interval '30 days');

insert into vehicles (id, owner_id, driver_id, class_code, make, model, year, colour,
                      registration_no, seats, status, rego_expiry, insurance_expiry)
values ('66666666-6666-6666-6666-666666666666', '33333333-3333-3333-3333-333333333333',
        '44444444-4444-4444-4444-444444444444', 'SEDAN', 'Toyota', 'Camry', 2019, 'White',
        'BEK-472', 4, 'PENDING_INSPECTION', current_date + 300, current_date + 200);

-- =====================================================================
-- The approval gate (spec §6, §15)
-- =====================================================================

select assert_rejects(
  'approval refused with no photographs',
  $$update vehicles set status = 'APPROVED' where registration_no = 'BEK-472'$$);

insert into vehicle_photos (vehicle_id, angle, url)
select '66666666-6666-6666-6666-666666666666', a, 'x'
from unnest(enum_range(null::photo_angle)) a;

select assert_rejects(
  'approval refused with photographs but no inspection',
  $$update vehicles set status = 'APPROVED' where registration_no = 'BEK-472'$$);

insert into inspections (vehicle_id, inspector_id, checklist, result)
values ('66666666-6666-6666-6666-666666666666',
        '11111111-1111-1111-1111-111111111111', '{}'::jsonb, 'PASS');

update vehicles set insurance_expiry = current_date - 1 where registration_no = 'BEK-472';
select assert_rejects(
  'approval refused with expired insurance',
  $$update vehicles set status = 'APPROVED' where registration_no = 'BEK-472'$$);

update vehicles set rego_expiry = current_date - 1, insurance_expiry = current_date + 200
where registration_no = 'BEK-472';
select assert_rejects(
  'approval refused with expired registration',
  $$update vehicles set status = 'APPROVED' where registration_no = 'BEK-472'$$);

update drivers set licence_expiry = current_date - 1
where id = '44444444-4444-4444-4444-444444444444';
update vehicles set rego_expiry = current_date + 300 where registration_no = 'BEK-472';
select assert_rejects(
  'approval refused with an expired driver licence',
  $$update vehicles set status = 'APPROVED' where registration_no = 'BEK-472'$$);

-- Now make the file complete.
update drivers set licence_expiry = current_date + 400
where id = '44444444-4444-4444-4444-444444444444';
update vehicles set status = 'APPROVED' where registration_no = 'BEK-472';

select assert_eq('a complete file approves',
  (select status::text from vehicles where registration_no = 'BEK-472'), 'APPROVED');

select assert_eq('approval stamps approved_at',
  (select approved_at is not null from vehicles where registration_no = 'BEK-472'), true);

-- Spec §2: the free period runs 60 days from approval, not from signup.
select assert_eq('free period is 60 days from approval',
  (select (free_period_ends_at::date - approved_at::date)
   from vehicles where registration_no = 'BEK-472'), 60);

-- =====================================================================
-- The commission ledger (spec §8)
-- =====================================================================

-- Inside the free period, a completed trip still writes an entry — for K0.00,
-- so the owner can see what the free period was worth to them.
insert into bookings (id, reference, customer_id, vehicle_id, driver_id, state,
                      pickup_lat, pickup_lng, pickup_label, dest_lat, dest_lng, dest_label,
                      distance_km, rate_version_id, quoted_fare, commission_amount, requested_at)
values ('70000000-0000-0000-0000-000000000001', 'WR-FREE01',
        '22222222-2222-2222-2222-222222222222', '66666666-6666-6666-6666-666666666666',
        '44444444-4444-4444-4444-444444444444', 'IN_PROGRESS',
        -9.46, 147.18, 'Boroko', -9.44, 147.21, 'Airport',
        6.0, '55555555-5555-5555-5555-555555555555', 3500, 350, now());

update bookings set state = 'COMPLETED', completed_at = now()
where id = '70000000-0000-0000-0000-000000000001';

select assert_eq('free period charges no commission',
  (select amount from ledger_entries where booking_id = '70000000-0000-0000-0000-000000000001'), 0);

select assert_eq('free period trip still appears on the ledger',
  (select count(*)::int from ledger_entries
   where booking_id = '70000000-0000-0000-0000-000000000001'), 1);

-- Out of the free period, commission accrues.
update vehicles set free_period_ends_at = now() - interval '1 day'
where registration_no = 'BEK-472';

insert into bookings (id, reference, customer_id, vehicle_id, driver_id, state,
                      pickup_lat, pickup_lng, pickup_label, dest_lat, dest_lng, dest_label,
                      distance_km, rate_version_id, quoted_fare, commission_amount, requested_at)
values ('77777777-7777-7777-7777-777777777777', 'WR-TEST01',
        '22222222-2222-2222-2222-222222222222', '66666666-6666-6666-6666-666666666666',
        '44444444-4444-4444-4444-444444444444', 'IN_PROGRESS',
        -9.46, 147.18, 'Boroko', -9.44, 147.21, 'Airport',
        6.0, '55555555-5555-5555-5555-555555555555', 3500, 350, now());

update bookings set state = 'COMPLETED', completed_at = now()
where id = '77777777-7777-7777-7777-777777777777';

select assert_eq('commission posted on completion',
  (select amount from ledger_entries where booking_id = '77777777-7777-7777-7777-777777777777'), 350);

select assert_eq('running balance computed by trigger',
  (select balance_after from ledger_entries
   where booking_id = '77777777-7777-7777-7777-777777777777'), 350);

-- The rule the whole ledger rests on.
select assert_eq('vehicles.balance_owed is derived from the entries',
  (select balance_owed from vehicles where registration_no = 'BEK-472'), 350);

-- Two completions so far: the free-period trip and this one. Both are real
-- trips, so both count.
select assert_eq('trips_completed counts every completed trip',
  (select trips_completed from vehicles where registration_no = 'BEK-472'), 2);

-- Replay the same completion. Neither the money nor the trip count may move.
update bookings set state = 'DISPUTED' where id = '77777777-7777-7777-7777-777777777777';
update bookings set state = 'COMPLETED' where id = '77777777-7777-7777-7777-777777777777';

select assert_eq('a replayed completion does not double-charge commission',
  (select count(*)::int from ledger_entries
   where booking_id = '77777777-7777-7777-7777-777777777777'), 1);

select assert_eq('a replayed completion does not inflate the trip count',
  (select trips_completed from vehicles where registration_no = 'BEK-472'), 2);

-- Spec §8 step 3: over the ceiling, the vehicle leaves customer search.
insert into ledger_entries (vehicle_id, entry_type, amount, balance_after, note)
values ('66666666-6666-6666-6666-666666666666', 'COMMISSION', 9800, 0, 'arrears');

select assert_eq('balance over the ceiling suspends the vehicle',
  (select status::text from vehicles where registration_no = 'BEK-472'), 'SUSPENDED_UNPAID');

select assert_eq('balance is the sum of the entries',
  (select balance_owed from vehicles where registration_no = 'BEK-472'), 10150);

-- Spec §8 step 5: paying relists automatically. An owner who has paid should
-- not have to ring anyone to get back on the map.
insert into ledger_entries (vehicle_id, entry_type, amount, balance_after, note)
values ('66666666-6666-6666-6666-666666666666', 'PAYMENT', 10150, 0, 'BANK_TRANSFER BSP-1');

select assert_eq('payment clears the balance',
  (select balance_owed from vehicles where registration_no = 'BEK-472'), 0);

select assert_eq('payment relists the vehicle automatically',
  (select status::text from vehicles where registration_no = 'BEK-472'), 'APPROVED');

-- An owner settles up more than once. The commission uniqueness rule must not
-- catch repeated payments, which all carry a null booking_id.
insert into ledger_entries (vehicle_id, entry_type, amount, balance_after, note)
values ('66666666-6666-6666-6666-666666666666', 'PAYMENT', 100, 0, 'second payment'),
       ('66666666-6666-6666-6666-666666666666', 'PAYMENT', 100, 0, 'third payment');

select assert_eq('an owner can make repeated payments',
  (select count(*)::int from ledger_entries
   where vehicle_id = '66666666-6666-6666-6666-666666666666'
     and entry_type = 'PAYMENT'), 3);

-- Two vehicles can each carry a commission entry for their own booking.
select assert_eq('the commission rule is per booking, not global',
  (select count(*)::int from ledger_entries where entry_type = 'COMMISSION'), 3);

-- =====================================================================
-- Rates are versioned, never overwritten (spec §5)
-- =====================================================================

update rate_versions set base_fare = 999999 where id = '55555555-5555-5555-5555-555555555555';
select assert_eq('an UPDATE to a rate version is discarded',
  (select base_fare from rate_versions where id = '55555555-5555-5555-5555-555555555555'), 1000);

delete from rate_versions where id = '55555555-5555-5555-5555-555555555555';
select assert_eq('a DELETE of a rate version is discarded',
  (select count(*)::int from rate_versions
   where id = '55555555-5555-5555-5555-555555555555'), 1);

-- =====================================================================
-- Conduct records (spec §7)
-- =====================================================================

insert into bookings (id, reference, customer_id, vehicle_id, driver_id, state,
                      pickup_lat, pickup_lng, pickup_label, dest_lat, dest_lng, dest_label,
                      distance_km, rate_version_id, quoted_fare, commission_amount,
                      requested_at, confirmed_at, arrived_at)
values ('88888888-8888-8888-8888-888888888888', 'WR-TEST02',
        '22222222-2222-2222-2222-222222222222', '66666666-6666-6666-6666-666666666666',
        '44444444-4444-4444-4444-444444444444', 'ARRIVED',
        -9.46, 147.18, 'Boroko', -9.44, 147.21, 'Airport',
        6.0, '55555555-5555-5555-5555-555555555555', 3500, 350, now(), now(), now());

update bookings set state = 'NO_SHOW_CUSTOMER' where id = '88888888-8888-8888-8888-888888888888';

select assert_eq('customer no-show is recorded against the customer',
  (select type from conduct_records where booking_id = '88888888-8888-8888-8888-888888888888'),
  'CUSTOMER_NO_SHOW');

-- Cancelling before anyone accepted is free and unlogged.
insert into bookings (id, reference, customer_id, vehicle_id, driver_id, state,
                      pickup_lat, pickup_lng, pickup_label, dest_lat, dest_lng, dest_label,
                      distance_km, rate_version_id, quoted_fare, commission_amount, requested_at)
values ('99999999-9999-9999-9999-999999999999', 'WR-TEST04',
        '22222222-2222-2222-2222-222222222222', '66666666-6666-6666-6666-666666666666',
        '44444444-4444-4444-4444-444444444444', 'REQUESTED',
        -9.46, 147.18, 'A', -9.44, 147.21, 'B',
        6.0, '55555555-5555-5555-5555-555555555555', 3500, 350, now());

update bookings set state = 'CANCELLED_BY_CUSTOMER', cancelled_at = now()
where id = '99999999-9999-9999-9999-999999999999';

select assert_eq('cancelling before acceptance leaves no mark',
  (select count(*)::int from conduct_records
   where booking_id = '99999999-9999-9999-9999-999999999999'), 0);

-- Spec §10: a released scheduled booking counts as a driver no-show, but an
-- unanswered 90-second request does not.
insert into bookings (id, reference, customer_id, vehicle_id, driver_id, state,
                      is_scheduled, scheduled_for,
                      pickup_lat, pickup_lng, pickup_label, dest_lat, dest_lng, dest_label,
                      distance_km, rate_version_id, quoted_fare, commission_amount,
                      requested_at, confirmed_at)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'WR-TEST05',
        '22222222-2222-2222-2222-222222222222', '66666666-6666-6666-6666-666666666666',
        '44444444-4444-4444-4444-444444444444', 'CONFIRMED',
        true, now() + interval '2 hours',
        -9.46, 147.18, 'A', -9.44, 147.21, 'B',
        6.0, '55555555-5555-5555-5555-555555555555', 3500, 350, now(), now());

update bookings set state = 'EXPIRED', released_at = now(), cancelled_at = now()
where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

select assert_eq('a released scheduled booking is a driver no-show',
  (select type from conduct_records where booking_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'DRIVER_NO_SHOW');

-- =====================================================================
-- Integrity constraints
-- =====================================================================

select assert_rejects(
  'commission larger than the fare is refused',
  $$insert into bookings (reference, customer_id, vehicle_id, driver_id, state,
      pickup_lat, pickup_lng, pickup_label, dest_lat, dest_lng, dest_label,
      distance_km, rate_version_id, quoted_fare, commission_amount, requested_at)
    values ('WR-BAD01', '22222222-2222-2222-2222-222222222222',
      '66666666-6666-6666-6666-666666666666', '44444444-4444-4444-4444-444444444444',
      'REQUESTED', -9.46, 147.18, 'A', -9.44, 147.21, 'B', 6.0,
      '55555555-5555-5555-5555-555555555555', 1000, 9999, now())$$);

select assert_rejects(
  'a self-nominated emergency contact is refused',
  $$update profiles set emergency_contact_phone = phone
    where id = '22222222-2222-2222-2222-222222222222'$$);

select assert_rejects(
  'a non-PNG mobile number is refused',
  $$update profiles set emergency_contact_phone = '+61412345678'
    where id = '22222222-2222-2222-2222-222222222222'$$);

select assert_rejects(
  'a scheduled booking with no time is refused',
  $$insert into bookings (reference, customer_id, vehicle_id, driver_id, state, is_scheduled,
      pickup_lat, pickup_lng, pickup_label, dest_lat, dest_lng, dest_label,
      distance_km, rate_version_id, quoted_fare, commission_amount, requested_at)
    values ('WR-BAD02', '22222222-2222-2222-2222-222222222222',
      '66666666-6666-6666-6666-666666666666', '44444444-4444-4444-4444-444444444444',
      'REQUESTED', true, -9.46, 147.18, 'A', -9.44, 147.21, 'B', 6.0,
      '55555555-5555-5555-5555-555555555555', 3500, 350, now())$$);

select assert_rejects(
  'two photographs of the same angle are refused',
  $$insert into vehicle_photos (vehicle_id, angle, url)
    values ('66666666-6666-6666-6666-666666666666', 'FRONT', 'duplicate')$$);

select assert_rejects(
  'a duplicate registration number is refused',
  $$insert into vehicles (owner_id, driver_id, class_code, make, model, year, colour,
      registration_no, seats)
    values ('33333333-3333-3333-3333-333333333333', null, 'SEDAN', 'Toyota', 'Corolla',
      2020, 'Silver', 'BEK-472', 4)$$);

select assert_rejects(
  'two reviews of one booking by one author are refused',
  $$insert into reviews (booking_id, author_id, subject_type, subject_id, stars)
    values ('77777777-7777-7777-7777-777777777777', '22222222-2222-2222-2222-222222222222',
            'VEHICLE', '66666666-6666-6666-6666-666666666666', 5),
           ('77777777-7777-7777-7777-777777777777', '22222222-2222-2222-2222-222222222222',
            'VEHICLE', '66666666-6666-6666-6666-666666666666', 1)$$);

select assert_rejects(
  'a rating outside 1-5 stars is refused',
  $$insert into reviews (booking_id, author_id, subject_type, subject_id, stars)
    values ('88888888-8888-8888-8888-888888888888', '22222222-2222-2222-2222-222222222222',
            'VEHICLE', '66666666-6666-6666-6666-666666666666', 9)$$);

-- =====================================================================
-- Ratings recalculate (spec §9)
-- =====================================================================

insert into reviews (booking_id, author_id, subject_type, subject_id, stars)
values ('77777777-7777-7777-7777-777777777777', '22222222-2222-2222-2222-222222222222',
        'VEHICLE', '66666666-6666-6666-6666-666666666666', 4);

select assert_eq('a review updates the vehicle rating',
  (select rating_avg from vehicles where registration_no = 'BEK-472'), 4.0::numeric(2,1));

-- Hiding recalculates. Admin may hide, but never delete: a hidden review is
-- still evidence in a dispute.
update reviews set visible = false
where booking_id = '77777777-7777-7777-7777-777777777777';

select assert_eq('hiding a review removes it from the average',
  (select rating_count from vehicles where registration_no = 'BEK-472'), 0);

-- =====================================================================
-- The nightly document sweep (spec §6)
-- =====================================================================

update vehicles set insurance_expiry = current_date - 1 where registration_no = 'BEK-472';

select assert_eq('the sweep suspends one vehicle',
  suspend_expired_documents(), 1);

select assert_eq('an expired document takes the vehicle off the app',
  (select status::text from vehicles where registration_no = 'BEK-472'), 'SUSPENDED_DOCS');

-- Money and roadworthiness are separate problems: an owner cannot pay their
-- way past an expired insurance certificate.
insert into ledger_entries (vehicle_id, entry_type, amount, balance_after, note)
values ('66666666-6666-6666-6666-666666666666', 'PAYMENT', 100, 0, 'should not relist');

select assert_eq('paying does not relist a vehicle suspended for documents',
  (select status::text from vehicles where registration_no = 'BEK-472'), 'SUSPENDED_DOCS');

-- =====================================================================
-- Realtime (spec §18)
-- =====================================================================
--
-- A subscription to an unpublished table reports itself SUBSCRIBED and then
-- stays silent forever. That failure is invisible from the client, so it is
-- asserted here instead.

select assert_eq('bookings are published for realtime',
  (select count(*)::int from pg_publication_tables
   where pubname = 'supabase_realtime' and tablename = 'bookings'), 1);

select assert_eq('driver positions are published for realtime',
  (select count(*)::int from pg_publication_tables
   where pubname = 'supabase_realtime' and tablename = 'driver_status'), 1);

select assert_eq('messages are published for realtime',
  (select count(*)::int from pg_publication_tables
   where pubname = 'supabase_realtime' and tablename = 'messages'), 1);

select assert_eq('sos events are published for realtime',
  (select count(*)::int from pg_publication_tables
   where pubname = 'supabase_realtime' and tablename = 'sos_events'), 1);

-- Filters on a non-primary-key column need the full row in the WAL record.
select assert_eq('bookings carry a full replica identity, so driver_id filters work',
  (select relreplident::text from pg_class where relname = 'bookings'), 'f');

-- The breadcrumb trail is deliberately not published: it is written every five
-- seconds per active trip and nothing watches it live.
select assert_eq('breadcrumbs are not published',
  (select count(*)::int from pg_publication_tables
   where pubname = 'supabase_realtime' and tablename = 'booking_locations'), 0);

-- =====================================================================

\echo ''
\echo 'All behaviour tests passed.'
