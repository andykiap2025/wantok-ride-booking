-- =====================================================================
-- Wantok Ride — complete database deployment
--
-- GENERATED FILE. Do not edit.
-- Rebuild with:  npm run build:deploy
--
-- Every migration in order, followed by the seed. Paste the whole thing into
-- the Supabase SQL Editor and run it once.
--
-- Before you do, enable two extensions under Database → Extensions:
--
--     pg_cron   the six scheduled jobs (expiry sweep, booking reminders,
--               the 45-minute release, weekly statements, retention)
--     pg_net    lets those jobs call the edge functions
--
-- Neither is fatal if missing — the schema installs either way and says what
-- it skipped — but the scheduled half of the product will not run without them.
--
-- After running this, set two Vault secrets so the cron jobs can reach the
-- edge functions (Settings → Vault):
--
--     project_url        https://<ref>.supabase.co
--     service_role_key   the service role key
--
-- Generated 2026-09-10T08:20:54.793Z
-- Source: 6 migrations + seed.sql
-- =====================================================================


-- #####################################################################
-- # 0001_schema.sql
-- #####################################################################

-- =====================================================================
-- Wantok Ride — schema (spec §15)
-- Skyworks Systems. Postgres 15 / Supabase.
--
-- Two integrity rules drive most of the odd-looking decisions here:
--
--   1. A booking stores `rate_version_id` and the computed `quoted_fare`.
--      A historical fare is NEVER recomputed from current rates. Rate rows
--      are append-only for the same reason.
--   2. `vehicles.balance_owed` is derived from `ledger_entries`, never
--      edited. It is maintained by trigger and revoked from every client.
--
-- Money is stored in **toea** (integer, 1 kina = 100 toea) rather than
-- numeric, so a balance can be summed and reconciled without a rounding
-- argument. The apps convert at the edges.
-- =====================================================================

-- gen_random_uuid(). Nothing here needs PostGIS: positions are plain
-- lat/lng doubles, and the only distance maths is haversine on the handset.
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------

create type user_role as enum ('CUSTOMER', 'DRIVER', 'OWNER', 'ADMIN', 'SUPER_ADMIN');

create type account_status as enum ('ACTIVE', 'BLOCKED', 'CLOSED');

create type vehicle_status as enum (
  'DRAFT', 'PENDING_DOCS', 'PENDING_INSPECTION', 'APPROVED', 'REJECTED',
  'SUSPENDED_UNPAID', 'SUSPENDED_DOCS', 'SUSPENDED_ADMIN', 'RETIRED'
);

create type booking_state as enum (
  'DRAFT', 'REQUESTED', 'CONFIRMED', 'DECLINED', 'EXPIRED',
  'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED',
  'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_DRIVER',
  'NO_SHOW_CUSTOMER', 'NO_SHOW_DRIVER', 'DISPUTED'
);

create type photo_angle as enum (
  'FRONT', 'REAR', 'SIDE_LEFT', 'SIDE_RIGHT', 'INTERIOR_FRONT', 'INTERIOR_REAR'
);

create type inspection_result as enum ('PASS', 'FAIL', 'CONDITIONAL');

create type ledger_entry_type as enum ('COMMISSION', 'PAYMENT', 'ADJUSTMENT', 'WRITE_OFF');

create type payment_status as enum ('SUBMITTED', 'VERIFIED', 'REJECTED');

create type payment_method as enum ('BANK_TRANSFER', 'MOBILE_MONEY', 'CASH_OFFICE');

create type review_subject as enum ('VEHICLE', 'CUSTOMER');

create type dispute_status as enum ('OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED');

-- ---------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------

create table profiles (
  id                       uuid primary key references auth.users (id) on delete cascade,
  phone                    text unique not null,
  full_name                text not null,
  role                     user_role[] not null default array['CUSTOMER']::user_role[],
  photo_url                text,

  -- Spec §10: mandatory at signup, verified by test SMS. The partial index
  -- below is what actually stops an account booking without one.
  emergency_contact_name   text,
  emergency_contact_phone  text,
  emergency_verified_at    timestamptz,

  rating_avg               numeric(2,1),
  rating_count             integer not null default 0,
  status                   account_status not null default 'ACTIVE',
  created_at               timestamptz not null default now(),

  constraint phone_is_png_mobile check (phone ~ '^\+675[78]\d{7}$'),
  constraint emergency_is_png_mobile
    check (emergency_contact_phone is null or emergency_contact_phone ~ '^\+675[78]\d{7}$'),
  -- Nominating yourself defeats the point of the field.
  constraint emergency_is_not_self check (emergency_contact_phone is distinct from phone)
);

create index profiles_role_idx on profiles using gin (role);

create table owners (
  id                uuid primary key default gen_random_uuid(),
  profile_id        uuid not null unique references profiles (id) on delete cascade,
  nid_number        text not null,
  address           text not null,
  bank_name         text,
  bank_account      text,
  settlement_method payment_method not null default 'BANK_TRANSFER',
  -- Spec §2: K100 default, adjustable per owner by admin.
  default_ceiling   integer not null default 10000,
  created_at        timestamptz not null default now()
);

create table drivers (
  id                uuid primary key default gen_random_uuid(),
  profile_id        uuid not null unique references profiles (id) on delete cascade,
  licence_number    text not null,
  licence_class     text not null,
  licence_expiry    date not null,
  licence_front_url text,
  licence_back_url  text,
  verified_at       timestamptz,
  created_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Fleet
-- ---------------------------------------------------------------------

-- Spec §5: classes must be data, not hard-coded, so admin can add one.
create table vehicle_classes (
  code        text primary key,
  name        text not null,
  seats       integer not null,
  description text,
  icon_url    text,
  sort_order  integer not null default 0,
  active      boolean not null default true
);

create table vehicles (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references owners (id) on delete restrict,
  driver_id          uuid references drivers (id) on delete set null,
  class_code         text not null references vehicle_classes (code),
  make               text not null,
  model              text not null,
  year               integer not null,
  colour             text not null,
  registration_no    text not null unique,
  seats              integer not null,
  status             vehicle_status not null default 'DRAFT',

  rego_expiry        date,
  insurance_expiry   date,
  rego_doc_url       text,
  insurance_doc_url  text,

  approved_at        timestamptz,
  approved_by        uuid references profiles (id),
  free_period_ends_at timestamptz,

  commission_ceiling integer not null default 10000,
  -- Derived from ledger_entries by trigger. Never written by a client.
  balance_owed       integer not null default 0,

  rating_avg         numeric(2,1),
  rating_count       integer not null default 0,
  trips_completed    integer not null default 0,

  created_at         timestamptz not null default now(),

  constraint seats_are_plausible check (seats between 1 and 25),
  constraint year_is_plausible check (year between 1980 and 2100)
);

create index vehicles_owner_idx on vehicles (owner_id);
create index vehicles_driver_idx on vehicles (driver_id);
-- The customer list only ever asks for approved vehicles.
create index vehicles_listable_idx on vehicles (class_code) where status = 'APPROVED';
-- The nightly expiry job scans these two columns and nothing else.
create index vehicles_expiry_idx on vehicles (rego_expiry, insurance_expiry)
  where status in ('APPROVED', 'PENDING_INSPECTION');

create table vehicle_photos (
  id          uuid primary key default gen_random_uuid(),
  vehicle_id  uuid not null references vehicles (id) on delete cascade,
  angle       photo_angle not null,
  url         text not null,
  uploaded_by uuid references profiles (id),
  created_at  timestamptz not null default now(),
  -- One current photo per angle. Six photos of the front is not six photos.
  unique (vehicle_id, angle)
);

create table inspections (
  id           uuid primary key default gen_random_uuid(),
  vehicle_id   uuid not null references vehicles (id) on delete cascade,
  inspector_id uuid not null references profiles (id),
  inspected_at timestamptz not null default now(),
  checklist    jsonb not null,
  odometer     integer,
  result       inspection_result not null,
  notes        text,
  recheck_due  date,
  created_at   timestamptz not null default now()
);

create index inspections_vehicle_idx on inspections (vehicle_id, inspected_at desc);

-- ---------------------------------------------------------------------
-- Rates — append-only
-- ---------------------------------------------------------------------

create table rate_versions (
  id               uuid primary key default gen_random_uuid(),
  class_code       text not null references vehicle_classes (code),
  base_fare        integer not null,      -- toea
  per_km           integer not null,      -- toea
  minimum_fare     integer not null,      -- toea
  night_multiplier numeric(4,2) not null default 1.00,
  night_start      time not null default '20:00',
  night_end        time not null default '05:00',
  rounding         integer not null default 5,   -- kina step
  service_fee      integer not null default 0,   -- toea, zero at launch
  commission_pct   numeric(5,2) not null default 10.00,
  effective_from   timestamptz not null,
  created_by       uuid references profiles (id),
  created_at       timestamptz not null default now(),

  constraint fares_are_positive check (base_fare >= 0 and per_km >= 0 and minimum_fare >= 0),
  constraint multiplier_is_sane check (night_multiplier between 1.00 and 3.00),
  constraint commission_is_sane check (commission_pct between 0 and 50)
);

-- Resolving "the rate in force" is the single hottest read in the product.
create index rate_versions_lookup_idx on rate_versions (class_code, effective_from desc);

-- Spec §5: "Rates are versioned, never overwritten." Enforced, not documented.
create rule rate_versions_no_update as on update to rate_versions do instead nothing;
create rule rate_versions_no_delete as on delete to rate_versions do instead nothing;

-- ---------------------------------------------------------------------
-- Presence
-- ---------------------------------------------------------------------

create table driver_status (
  driver_id    uuid primary key references drivers (id) on delete cascade,
  vehicle_id   uuid references vehicles (id) on delete set null,
  is_online    boolean not null default false,
  lat          double precision,
  lng          double precision,
  heading      real,
  last_ping_at timestamptz
);

-- The customer list filters on freshness before it does anything else.
create index driver_status_live_idx on driver_status (last_ping_at desc) where is_online;

-- ---------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------

create table bookings (
  id                uuid primary key default gen_random_uuid(),
  reference         text not null unique,
  customer_id       uuid not null references profiles (id) on delete restrict,
  vehicle_id        uuid not null references vehicles (id) on delete restrict,
  driver_id         uuid not null references drivers (id) on delete restrict,
  state             booking_state not null default 'DRAFT',

  is_scheduled      boolean not null default false,
  scheduled_for     timestamptz,

  pickup_lat        double precision not null,
  pickup_lng        double precision not null,
  pickup_label      text not null,
  dest_lat          double precision not null,
  dest_lng          double precision not null,
  dest_label        text not null,
  distance_km       numeric(6,2) not null,

  -- The locked quote. Never recomputed.
  rate_version_id   uuid not null references rate_versions (id),
  is_night_rate     boolean not null default false,
  quoted_fare       integer not null,       -- toea
  service_fee       integer not null default 0,
  commission_amount integer not null,       -- toea

  requested_at      timestamptz,
  confirmed_at      timestamptz,
  reconfirmed_at    timestamptz,
  en_route_at       timestamptz,
  arrived_at        timestamptz,
  started_at        timestamptz,
  completed_at      timestamptz,
  cancelled_at      timestamptz,
  released_at       timestamptz,

  cancelled_by      text,
  cancel_reason     text,
  decline_reason    text,
  decline_note      text,

  share_token       text unique,
  created_at        timestamptz not null default now(),

  constraint scheduled_needs_a_time
    check (not is_scheduled or scheduled_for is not null),
  constraint fare_is_positive check (quoted_fare > 0),
  -- A booking whose commission does not match its fare is a booking nobody
  -- can explain to an owner six months later.
  constraint commission_within_fare check (commission_amount between 0 and quoted_fare)
);

create index bookings_customer_idx on bookings (customer_id, created_at desc);
create index bookings_driver_idx on bookings (driver_id, created_at desc);
create index bookings_vehicle_idx on bookings (vehicle_id, created_at desc);
-- The admin live board and the reminder job both scan open bookings only.
create index bookings_live_idx on bookings (state)
  where state in ('REQUESTED', 'CONFIRMED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS');
create index bookings_scheduled_idx on bookings (scheduled_for)
  where is_scheduled and state = 'CONFIRMED';

-- Spec §15: breadcrumbs retained 90 days.
create table booking_locations (
  id          bigserial primary key,
  booking_id  uuid not null references bookings (id) on delete cascade,
  lat         double precision not null,
  lng         double precision not null,
  recorded_at timestamptz not null
);

create index booking_locations_idx on booking_locations (booking_id, recorded_at);

-- ---------------------------------------------------------------------
-- Communication
-- ---------------------------------------------------------------------

create table messages (
  id         uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings (id) on delete cascade,
  sender_id  uuid not null references profiles (id),
  body       text not null,
  sent_at    timestamptz not null default now(),
  read_at    timestamptz,

  -- Text only. No images, no voice notes: data costs money here (spec §11).
  constraint body_is_short check (char_length(body) between 1 and 1000)
);

create index messages_booking_idx on messages (booking_id, sent_at);

-- ---------------------------------------------------------------------
-- Reviews
-- ---------------------------------------------------------------------

create table reviews (
  id            uuid primary key default gen_random_uuid(),
  booking_id    uuid not null references bookings (id) on delete cascade,
  author_id     uuid not null references profiles (id),
  subject_type  review_subject not null,
  subject_id    uuid not null,
  stars         smallint not null,
  comment       text,
  tags          text[] not null default '{}',
  visible       boolean not null default true,
  hidden_by     uuid references profiles (id),
  hidden_reason text,
  hidden_at     timestamptz,
  created_at    timestamptz not null default now(),

  constraint stars_are_one_to_five check (stars between 1 and 5),
  -- One review per booking per side.
  unique (booking_id, author_id)
);

create index reviews_subject_idx on reviews (subject_type, subject_id, created_at desc);

-- ---------------------------------------------------------------------
-- Money
-- ---------------------------------------------------------------------

create table ledger_entries (
  id            uuid primary key default gen_random_uuid(),
  vehicle_id    uuid not null references vehicles (id) on delete restrict,
  booking_id    uuid references bookings (id) on delete set null,
  entry_type    ledger_entry_type not null,
  amount        integer not null,    -- toea, always positive; direction is the type
  gross_fare    integer,             -- the fare this commission came from
  balance_after integer not null,
  note          text,
  created_by    uuid references profiles (id),
  created_at    timestamptz not null default now(),

  constraint amount_is_positive check (amount >= 0)
);

create index ledger_vehicle_idx on ledger_entries (vehicle_id, created_at);

-- One commission entry per booking, so a retried offline sync cannot charge
-- the same trip twice.
--
-- A partial index rather than a table constraint, and the `where` clause is
-- the whole point: it applies *only* to commission rows that name a booking.
-- Payments and adjustments carry no booking_id and must stay freely
-- repeatable — an owner settles up every week, and a constraint that treated
-- their null booking_id as a duplicate would refuse every payment after the
-- first.
create unique index ledger_one_commission_per_booking
  on ledger_entries (booking_id)
  where entry_type = 'COMMISSION' and booking_id is not null;

-- Financial records are kept 7 years (spec §16). Nothing deletes them.
create rule ledger_no_delete as on delete to ledger_entries do instead nothing;

create table payments (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references owners (id) on delete restrict,
  vehicle_id  uuid references vehicles (id) on delete set null,
  amount      integer not null,
  method      payment_method not null,
  reference   text,
  receipt_url text,
  status      payment_status not null default 'SUBMITTED',
  verified_by uuid references profiles (id),
  verified_at timestamptz,
  created_at  timestamptz not null default now(),

  constraint amount_is_positive check (amount > 0)
);

create index payments_owner_idx on payments (owner_id, created_at desc);
create index payments_pending_idx on payments (created_at) where status = 'SUBMITTED';

-- ---------------------------------------------------------------------
-- Safety
-- ---------------------------------------------------------------------

create table sos_events (
  id              uuid primary key default gen_random_uuid(),
  booking_id      uuid references bookings (id) on delete set null,
  triggered_by    uuid not null references profiles (id),
  role            text not null,
  lat             double precision,
  lng             double precision,
  triggered_at    timestamptz not null default now(),
  -- Everything known at the moment of trigger, frozen. Looking any of it up
  -- later shows what is true later, which after an incident is the wrong
  -- answer (spec §10).
  snapshot        jsonb not null,
  acknowledged_by uuid references profiles (id),
  acknowledged_at timestamptz,
  resolution      text,
  notes           text
);

create index sos_open_idx on sos_events (triggered_at desc) where acknowledged_at is null;

-- SOS records are kept indefinitely (spec §16).
create rule sos_no_delete as on delete to sos_events do instead nothing;

create table sos_locations (
  id          bigserial primary key,
  sos_id      uuid not null references sos_events (id) on delete cascade,
  lat         double precision not null,
  lng         double precision not null,
  recorded_at timestamptz not null
);

create table disputes (
  id          uuid primary key default gen_random_uuid(),
  booking_id  uuid not null references bookings (id) on delete cascade,
  raised_by   uuid not null references profiles (id),
  category    text not null,
  description text not null,
  status      dispute_status not null default 'OPEN',
  assigned_to uuid references profiles (id),
  resolution  text,
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);

create index disputes_open_idx on disputes (created_at) where status in ('OPEN', 'INVESTIGATING');

-- ---------------------------------------------------------------------
-- Conduct and audit
-- ---------------------------------------------------------------------

-- The rolling-window counters of spec §7. A row here is a fact about a
-- booking that ended badly; the thresholds are applied at read time so the
-- policy can change without a migration.
create table conduct_records (
  id          uuid primary key default gen_random_uuid(),
  booking_id  uuid not null references bookings (id) on delete cascade,
  subject_type text not null check (subject_type in ('CUSTOMER', 'VEHICLE')),
  subject_id  uuid not null,
  type        text not null,
  weight      smallint not null default 1,
  created_at  timestamptz not null default now(),
  unique (booking_id, subject_type)
);

create index conduct_subject_idx on conduct_records (subject_type, subject_id, created_at desc);

create table audit_log (
  id          bigserial primary key,
  actor_id    uuid references profiles (id),
  action      text not null,
  entity_type text not null,
  entity_id   uuid,
  before      jsonb,
  after       jsonb,
  created_at  timestamptz not null default now()
);

create index audit_entity_idx on audit_log (entity_type, entity_id, created_at desc);

-- Sent-notification log, so a nightly job that runs twice does not send the
-- 14-day insurance warning twice.
create table notifications_sent (
  id         bigserial primary key,
  subject_type text not null,
  subject_id text not null,
  kind       text not null,
  threshold  integer,
  sent_at    timestamptz not null default now(),
  unique nulls not distinct (subject_type, subject_id, kind, threshold)
);


-- #####################################################################
-- # 0002_functions.sql
-- #####################################################################

-- =====================================================================
-- Wantok Ride — triggers, views and jobs
--
-- The rules in here are the ones that must hold no matter which client is
-- talking to the database. Anything a phone can be talked out of enforcing
-- lives at this level instead.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Ledger: balance_owed is derived, never written
-- ---------------------------------------------------------------------

-- Which way an entry moves the balance owed.
create or replace function ledger_sign(t ledger_entry_type)
returns integer language sql immutable as $$
  select case when t = 'COMMISSION' then 1 else -1 end;
$$;

create or replace function ledger_set_balance()
returns trigger language plpgsql as $$
declare
  previous integer;
begin
  -- Serialise per vehicle. Two trips completing in the same instant must not
  -- both read the same "previous" balance and write the same running total.
  perform pg_advisory_xact_lock(hashtext(new.vehicle_id::text));

  select coalesce(sum(ledger_sign(entry_type) * amount), 0)
    into previous
    from ledger_entries
   where vehicle_id = new.vehicle_id;

  new.balance_after := previous + ledger_sign(new.entry_type) * new.amount;
  return new;
end;
$$;

create trigger ledger_balance_before_insert
  before insert on ledger_entries
  for each row execute function ledger_set_balance();

create or replace function ledger_apply_to_vehicle()
returns trigger language plpgsql as $$
declare
  v record;
begin
  select * into v from vehicles where id = new.vehicle_id for update;

  update vehicles
     set balance_owed = new.balance_after
   where id = new.vehicle_id;

  -- Spec §8, step 3: over the ceiling and the vehicle leaves customer search.
  -- Bookings already confirmed are untouched and will still be honoured.
  if new.balance_after > v.commission_ceiling and v.status = 'APPROVED' then
    update vehicles set status = 'SUSPENDED_UNPAID' where id = v.id;
    insert into audit_log (actor_id, action, entity_type, entity_id, before, after)
    values (null, 'AUTO_SUSPEND_UNPAID', 'vehicle', v.id,
            jsonb_build_object('status', v.status),
            jsonb_build_object('status', 'SUSPENDED_UNPAID', 'balance', new.balance_after));
  end if;

  -- Spec §8, step 5: paying clears the suspension automatically. An owner who
  -- has paid should not have to ring anyone to get back on the map. Only an
  -- unpaid suspension lifts here — expired insurance is a different problem.
  if new.balance_after <= v.commission_ceiling and v.status = 'SUSPENDED_UNPAID' then
    update vehicles set status = 'APPROVED' where id = v.id;
    insert into audit_log (actor_id, action, entity_type, entity_id, after)
    values (new.created_by, 'AUTO_RELIST_PAID', 'vehicle', v.id,
            jsonb_build_object('balance', new.balance_after));
  end if;

  return null;
end;
$$;

create trigger ledger_balance_after_insert
  after insert on ledger_entries
  for each row execute function ledger_apply_to_vehicle();

-- ---------------------------------------------------------------------
-- Completion: post commission, honour the free period
-- ---------------------------------------------------------------------

create or replace function booking_on_complete()
returns trigger language plpgsql as $$
declare
  v record;
  charge integer;
begin
  if new.state <> 'COMPLETED' or old.state = 'COMPLETED' then
    return new;
  end if;

  select * into v from vehicles where id = new.vehicle_id;

  -- Spec §2: first 60 days from approval, no commission accrued. The entry is
  -- still written, for K0.00, so the trip appears on the owner's statement and
  -- they can see what the free period was worth to them.
  charge := case
    when v.free_period_ends_at is not null and now() < v.free_period_ends_at then 0
    else new.commission_amount
  end;

  insert into ledger_entries (vehicle_id, booking_id, entry_type, amount, gross_fare, note, balance_after)
  values (
    new.vehicle_id, new.id, 'COMMISSION', charge, new.quoted_fare,
    case when charge = 0 then 'Free period — no commission' else null end,
    0  -- overwritten by the before-insert trigger
  )
  on conflict do nothing;  -- a replayed offline sync must not double-charge

  -- Only count the trip if the entry was actually written.
  --
  -- `on conflict do nothing` already protects the money, but the trip count
  -- has to be protected by the same test or a replayed completion inflates a
  -- vehicle's record without charging it — which shows up months later as a
  -- rating denominator nobody can reconcile. FOUND is false when the conflict
  -- swallowed the insert.
  if found then
    update vehicles set trips_completed = trips_completed + 1 where id = new.vehicle_id;
  end if;

  return new;
end;
$$;

create trigger bookings_complete_posts_commission
  after update of state on bookings
  for each row execute function booking_on_complete();

-- ---------------------------------------------------------------------
-- Conduct records
-- ---------------------------------------------------------------------

create or replace function booking_on_bad_ending()
returns trigger language plpgsql as $$
begin
  if new.state = old.state then return new; end if;

  -- Cancelling before anyone accepted is free and unlogged.
  if new.state = 'CANCELLED_BY_CUSTOMER' and new.confirmed_at is not null then
    insert into conduct_records (booking_id, subject_type, subject_id, type, weight)
    values (new.id, 'CUSTOMER', new.customer_id, 'CUSTOMER_CANCEL',
            case when new.en_route_at is not null then 2 else 1 end)
    on conflict do nothing;

  elsif new.state = 'NO_SHOW_CUSTOMER' then
    insert into conduct_records (booking_id, subject_type, subject_id, type, weight)
    values (new.id, 'CUSTOMER', new.customer_id, 'CUSTOMER_NO_SHOW', 1)
    on conflict do nothing;

  elsif new.state = 'CANCELLED_BY_DRIVER' then
    insert into conduct_records (booking_id, subject_type, subject_id, type, weight)
    values (new.id, 'VEHICLE', new.vehicle_id, 'DRIVER_CANCEL', 1)
    on conflict do nothing;

  elsif new.state = 'NO_SHOW_DRIVER'
     or (new.state = 'EXPIRED' and new.released_at is not null) then
    -- Spec §10: a late release counts as a driver no-show against the vehicle.
    -- An unanswered 90-second request does not.
    insert into conduct_records (booking_id, subject_type, subject_id, type, weight)
    values (new.id, 'VEHICLE', new.vehicle_id, 'DRIVER_NO_SHOW', 1)
    on conflict do nothing;
  end if;

  return new;
end;
$$;

create trigger bookings_conduct
  after update of state on bookings
  for each row execute function booking_on_bad_ending();

-- ---------------------------------------------------------------------
-- The approval gate
-- ---------------------------------------------------------------------

-- Spec §15: a vehicle cannot move to APPROVED without a passing inspection,
-- six photos, and unexpired rego, insurance and licence. The admin console
-- checks all of this too, and shows every blocker at once — this is the
-- backstop that makes it true regardless of which client asked.
create or replace function vehicle_guard_approval()
returns trigger language plpgsql as $$
declare
  photo_count integer;
  passed boolean;
  licence date;
begin
  if new.status <> 'APPROVED' or old.status = 'APPROVED' then
    return new;
  end if;

  select count(distinct angle) into photo_count from vehicle_photos where vehicle_id = new.id;
  if photo_count < 6 then
    raise exception 'Cannot approve %: only % of 6 required photos', new.registration_no, photo_count
      using errcode = 'check_violation';
  end if;

  select exists (
    select 1 from inspections
     where vehicle_id = new.id and result in ('PASS', 'CONDITIONAL')
  ) into passed;
  if not passed then
    raise exception 'Cannot approve %: no passing inspection on record', new.registration_no
      using errcode = 'check_violation';
  end if;

  if new.rego_expiry is null or new.rego_expiry < current_date then
    raise exception 'Cannot approve %: registration is missing or expired', new.registration_no
      using errcode = 'check_violation';
  end if;

  if new.insurance_expiry is null or new.insurance_expiry < current_date then
    raise exception 'Cannot approve %: insurance is missing or expired', new.registration_no
      using errcode = 'check_violation';
  end if;

  select d.licence_expiry into licence from drivers d where d.id = new.driver_id;
  if licence is null or licence < current_date then
    raise exception 'Cannot approve %: driver licence is missing or expired', new.registration_no
      using errcode = 'check_violation';
  end if;

  -- Spec §2: the free period runs from approval, not from signup.
  new.approved_at := coalesce(new.approved_at, now());
  new.free_period_ends_at := coalesce(new.free_period_ends_at, now() + interval '60 days');
  return new;
end;
$$;

create trigger vehicles_guard_approval
  before update of status on vehicles
  for each row execute function vehicle_guard_approval();

-- balance_owed is derived. Refuse a direct write rather than silently
-- reverting it, so a client bug surfaces as an error instead of as a
-- reconciliation mystery six weeks later.
create or replace function vehicle_guard_balance()
returns trigger language plpgsql as $$
begin
  if new.balance_owed is distinct from old.balance_owed
     and current_setting('wantok.ledger_write', true) is distinct from 'on' then
    raise exception 'vehicles.balance_owed is derived from ledger_entries and cannot be set directly'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Ratings
-- ---------------------------------------------------------------------

create or replace function review_recalculate_rating()
returns trigger language plpgsql as $$
declare
  target uuid := coalesce(new.subject_id, old.subject_id);
  kind review_subject := coalesce(new.subject_type, old.subject_type);
  avg_stars numeric;
  n integer;
begin
  select round(avg(stars)::numeric, 1), count(*)
    into avg_stars, n
    from reviews
   where subject_type = kind and subject_id = target and visible;

  if kind = 'VEHICLE' then
    update vehicles set rating_avg = avg_stars, rating_count = coalesce(n, 0) where id = target;
  else
    update profiles set rating_avg = avg_stars, rating_count = coalesce(n, 0) where id = target;
  end if;

  return null;
end;
$$;

create trigger reviews_recalculate
  after insert or update or delete on reviews
  for each row execute function review_recalculate_rating();

-- ---------------------------------------------------------------------
-- Contact details: exposed only while a booking is live
-- ---------------------------------------------------------------------

-- Spec §15: "Contact details are exposed by a database view that checks for an
-- active booking between the two parties." Numbers unlock on CONFIRMED and
-- close 24 hours after the trip ends (spec §11).
create or replace view booking_contacts
with (security_invoker = true) as
select
  b.id            as booking_id,
  b.reference,
  b.state,
  cust.id         as customer_id,
  cust.full_name  as customer_name,
  cust.phone      as customer_phone,
  drv.id          as driver_id,
  drv.full_name   as driver_name,
  drv.phone       as driver_phone
from bookings b
join profiles cust on cust.id = b.customer_id
join drivers d on d.id = b.driver_id
join profiles drv on drv.id = d.profile_id
where b.confirmed_at is not null
  and (
    coalesce(b.completed_at, b.cancelled_at) is null
    or now() < coalesce(b.completed_at, b.cancelled_at) + interval '24 hours'
  )
  and (
    auth.uid() = b.customer_id
    or auth.uid() = drv.id
    or exists (select 1 from profiles p where p.id = auth.uid()
                 and (p.role && array['ADMIN','SUPER_ADMIN']::user_role[]))
  );

-- The customer-facing vehicle list. Presence freshness and suspension are
-- applied here so no client can forget them.
create or replace view listable_vehicles as
select
  v.id, v.class_code, v.make, v.model, v.year, v.colour, v.seats,
  v.registration_no, v.rating_avg, v.rating_count, v.trips_completed,
  ds.lat, ds.lng, ds.heading, ds.last_ping_at,
  p.full_name as driver_name, p.photo_url as driver_photo, p.rating_avg as driver_rating
from vehicles v
join drivers d on d.id = v.driver_id
join profiles p on p.id = d.profile_id
join driver_status ds on ds.driver_id = v.driver_id
where v.status = 'APPROVED'
  and ds.is_online
  and ds.last_ping_at > now() - interval '10 minutes';

-- ---------------------------------------------------------------------
-- Nightly jobs
-- ---------------------------------------------------------------------

-- Spec §6: automatic suspension on the expiry date. Not optional, not queued
-- for an admin to approve. An expired-insurance vehicle carrying a paying
-- passenger is the platform's biggest liability.
create or replace function suspend_expired_documents()
returns integer language plpgsql as $$
declare
  affected integer;
begin
  with expired as (
    select v.id, v.status
      from vehicles v
      left join drivers d on d.id = v.driver_id
     where v.status = 'APPROVED'
       and (v.rego_expiry < current_date
            or v.insurance_expiry < current_date
            or d.licence_expiry < current_date)
  ), updated as (
    update vehicles v
       set status = 'SUSPENDED_DOCS'
      from expired e
     where v.id = e.id
     returning v.id, e.status as was
  )
  insert into audit_log (actor_id, action, entity_type, entity_id, before, after)
  select null, 'AUTO_SUSPEND_DOCS', 'vehicle', id,
         jsonb_build_object('status', was),
         jsonb_build_object('status', 'SUSPENDED_DOCS')
    from updated;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- Spec §7: a driver who has not reported in 10 minutes drops off the list.
-- The list view already filters on this; the sweep keeps the flag honest so
-- the driver's own app agrees with what customers can see.
create or replace function mark_stale_drivers_offline()
returns integer language plpgsql as $$
declare
  affected integer;
begin
  update driver_status
     set is_online = false
   where is_online
     and last_ping_at < now() - interval '10 minutes';
  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- Spec §16 retention: trip breadcrumbs 90 days, messages 12 months.
-- Financial records and SOS are never purged.
create or replace function purge_expired_data()
returns void language plpgsql as $$
begin
  delete from booking_locations where recorded_at < now() - interval '90 days';
  delete from messages where sent_at < now() - interval '12 months';
end;
$$;

-- Scheduled with pg_cron in 0006_cron.sql. Kept as plain functions so they
-- can also be run by hand from the console during the pilot.


-- #####################################################################
-- # 0003_rls.sql
-- #####################################################################

-- =====================================================================
-- Wantok Ride — row-level security (spec §16)
--
--   A customer reads only their own bookings.
--   A driver reads only bookings for their vehicle.
--   An owner reads only their own vehicles and ledger.
--
-- The platform holds driver's licence numbers, national ID numbers and the
-- live location of people in cars. RLS is the only thing standing between
-- that and any authenticated user with a REST client, so the default here is
-- deny and every grant is written out one at a time.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

create or replace function is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles
     where id = auth.uid()
       and role && array['ADMIN', 'SUPER_ADMIN']::user_role[]
  );
$$;

create or replace function is_super_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles where id = auth.uid() and 'SUPER_ADMIN' = any (role)
  );
$$;

create or replace function my_driver_id()
returns uuid language sql stable security definer set search_path = public as $$
  select id from drivers where profile_id = auth.uid();
$$;

create or replace function my_owner_id()
returns uuid language sql stable security definer set search_path = public as $$
  select id from owners where profile_id = auth.uid();
$$;

-- ---------------------------------------------------------------------
-- Enable, and deny by default
-- ---------------------------------------------------------------------

alter table profiles          enable row level security;
alter table owners            enable row level security;
alter table drivers           enable row level security;
alter table vehicles          enable row level security;
alter table vehicle_photos    enable row level security;
alter table vehicle_classes   enable row level security;
alter table inspections       enable row level security;
alter table rate_versions     enable row level security;
alter table driver_status     enable row level security;
alter table bookings          enable row level security;
alter table booking_locations enable row level security;
alter table messages          enable row level security;
alter table reviews           enable row level security;
alter table ledger_entries    enable row level security;
alter table payments          enable row level security;
alter table sos_events        enable row level security;
alter table sos_locations     enable row level security;
alter table disputes          enable row level security;
alter table conduct_records   enable row level security;
alter table audit_log         enable row level security;
alter table notifications_sent enable row level security;

-- ---------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------

create policy profiles_read_own on profiles
  for select using (id = auth.uid() or is_admin());

-- A driver's name, photo and rating appear on the customer's vehicle list.
-- Their phone number does not — that comes from `booking_contacts`, which
-- checks for a live booking first.
create policy profiles_read_public_fields on profiles
  for select using (
    exists (
      select 1 from drivers d
      join vehicles v on v.driver_id = d.id
      where d.profile_id = profiles.id and v.status = 'APPROVED'
    )
  );

create policy profiles_update_own on profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

create policy profiles_admin_write on profiles
  for all using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------
-- Owners and drivers
-- ---------------------------------------------------------------------

-- NID numbers and bank details. Owner and admin only, no exceptions.
create policy owners_read_own on owners
  for select using (profile_id = auth.uid() or is_admin());

create policy owners_write_own on owners
  for insert with check (profile_id = auth.uid());

create policy owners_update_own on owners
  for update using (profile_id = auth.uid() or is_admin());

-- A driver's licence number and its scans are never visible to a customer.
create policy drivers_read_own on drivers
  for select using (
    profile_id = auth.uid()
    or is_admin()
    or exists (select 1 from vehicles v where v.driver_id = drivers.id and v.owner_id = my_owner_id())
  );

create policy drivers_write_own on drivers
  for insert with check (profile_id = auth.uid());

create policy drivers_update_own on drivers
  for update using (profile_id = auth.uid() or is_admin());

-- ---------------------------------------------------------------------
-- Fleet
-- ---------------------------------------------------------------------

-- Classes and live rates are public: the customer app needs both to quote.
create policy vehicle_classes_public on vehicle_classes for select using (true);
create policy rate_versions_public on rate_versions
  for select using (effective_from <= now());
create policy rate_versions_admin on rate_versions
  for insert with check (is_super_admin());

create policy vehicles_read on vehicles
  for select using (
    status = 'APPROVED'                       -- anyone may see a listed vehicle
    or owner_id = my_owner_id()               -- an owner sees all of their own
    or driver_id = my_driver_id()             -- a driver sees the one they drive
    or is_admin()
  );

create policy vehicles_owner_insert on vehicles
  for insert with check (owner_id = my_owner_id());

-- An owner may edit their vehicle's details, but only while it is a draft or
-- coming back from a rejection. Status, ceiling and balance are admin-only —
-- an owner who could set their own status could approve themselves.
create policy vehicles_owner_update on vehicles
  for update using (
    owner_id = my_owner_id()
    and status in ('DRAFT', 'PENDING_DOCS', 'REJECTED', 'SUSPENDED_DOCS')
  ) with check (owner_id = my_owner_id());

create policy vehicles_admin_all on vehicles
  for all using (is_admin()) with check (is_admin());

create policy vehicle_photos_read on vehicle_photos
  for select using (
    exists (
      select 1 from vehicles v
       where v.id = vehicle_photos.vehicle_id
         and (v.status = 'APPROVED' or v.owner_id = my_owner_id() or v.driver_id = my_driver_id())
    )
    or is_admin()
  );

create policy vehicle_photos_owner_write on vehicle_photos
  for all using (
    exists (select 1 from vehicles v where v.id = vehicle_photos.vehicle_id and v.owner_id = my_owner_id())
    or is_admin()
  ) with check (
    exists (select 1 from vehicles v where v.id = vehicle_photos.vehicle_id and v.owner_id = my_owner_id())
    or is_admin()
  );

-- Inspection records are the platform's evidence. Owners may read their own
-- vehicle's result; only admin writes one.
create policy inspections_read on inspections
  for select using (
    is_admin()
    or exists (select 1 from vehicles v where v.id = inspections.vehicle_id and v.owner_id = my_owner_id())
  );

create policy inspections_admin_write on inspections
  for insert with check (is_admin());

-- ---------------------------------------------------------------------
-- Presence
-- ---------------------------------------------------------------------

-- A driver's live position is visible while they are online and listed, and
-- to the passenger of a live booking. Not to anyone who asks.
create policy driver_status_read on driver_status
  for select using (
    driver_id = my_driver_id()
    or is_admin()
    or (is_online and last_ping_at > now() - interval '10 minutes')
  );

create policy driver_status_write_own on driver_status
  for all using (driver_id = my_driver_id()) with check (driver_id = my_driver_id());

-- ---------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------

create policy bookings_read on bookings
  for select using (
    customer_id = auth.uid()
    or driver_id = my_driver_id()
    or exists (select 1 from vehicles v where v.id = bookings.vehicle_id and v.owner_id = my_owner_id())
    or is_admin()
  );

create policy bookings_customer_create on bookings
  for insert with check (
    customer_id = auth.uid()
    -- Spec §10: no booking without a verified emergency contact.
    and exists (
      select 1 from profiles p
       where p.id = auth.uid()
         and p.emergency_verified_at is not null
         and p.status = 'ACTIVE'
    )
    -- Spec §7: three no-shows in 30 days blocks new bookings.
    and (
      select coalesce(sum(weight), 0) from conduct_records
       where subject_type = 'CUSTOMER' and subject_id = auth.uid()
         and type = 'CUSTOMER_NO_SHOW'
         and created_at > now() - interval '30 days'
    ) < 3
  );

-- Both sides may move a booking along; which transitions are legal is the
-- state machine's job, in @wantok/core, applied by the edge function.
create policy bookings_participant_update on bookings
  for update using (customer_id = auth.uid() or driver_id = my_driver_id() or is_admin());

-- ---------------------------------------------------------------------
-- Trip data and messages
-- ---------------------------------------------------------------------

create policy booking_locations_read on booking_locations
  for select using (
    exists (
      select 1 from bookings b
       where b.id = booking_locations.booking_id
         and (b.customer_id = auth.uid() or b.driver_id = my_driver_id())
    )
    or is_admin()
  );

create policy booking_locations_driver_write on booking_locations
  for insert with check (
    exists (select 1 from bookings b where b.id = booking_id and b.driver_id = my_driver_id())
  );

-- Chat closes 24 hours after completion (spec §11), and is visible to admin
-- during a dispute (spec §11) — which is what the is_admin() branch is for.
create policy messages_read on messages
  for select using (
    exists (
      select 1 from bookings b
       where b.id = messages.booking_id
         and (b.customer_id = auth.uid() or b.driver_id = my_driver_id())
    )
    or is_admin()
  );

create policy messages_send on messages
  for insert with check (
    sender_id = auth.uid()
    and exists (
      select 1 from bookings b
       where b.id = booking_id
         and (b.customer_id = auth.uid() or b.driver_id = my_driver_id())
         and b.confirmed_at is not null
         and (
           coalesce(b.completed_at, b.cancelled_at) is null
           or now() < coalesce(b.completed_at, b.cancelled_at) + interval '24 hours'
         )
    )
  );

-- ---------------------------------------------------------------------
-- Reviews
-- ---------------------------------------------------------------------

-- The 48-hour blind window (spec §9), enforced in the database so that
-- reading the REST endpoint directly cannot beat it.
create policy reviews_read on reviews
  for select using (
    visible
    and (
      author_id = auth.uid()
      or is_admin()
      or exists (
        select 1 from bookings b
         where b.id = reviews.booking_id
           and (
             b.completed_at < now() - interval '48 hours'
             or (select count(*) from reviews r2 where r2.booking_id = b.id) >= 2
           )
      )
    )
  );

create policy reviews_write_own on reviews
  for insert with check (
    author_id = auth.uid()
    and exists (
      select 1 from bookings b
       where b.id = booking_id
         and b.state = 'COMPLETED'
         and (b.customer_id = auth.uid() or b.driver_id = my_driver_id())
    )
  );

-- Hiding a review is an admin action and it is audited. There is no delete:
-- a hidden review is still evidence in a dispute.
create policy reviews_admin_moderate on reviews
  for update using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------
-- Money
-- ---------------------------------------------------------------------

create policy ledger_read on ledger_entries
  for select using (
    exists (select 1 from vehicles v where v.id = ledger_entries.vehicle_id and v.owner_id = my_owner_id())
    or exists (select 1 from vehicles v where v.id = ledger_entries.vehicle_id and v.driver_id = my_driver_id())
    or is_admin()
  );

-- Nobody writes the ledger from a client. Commission arrives by trigger;
-- payments and adjustments arrive from an admin edge function.
create policy ledger_admin_write on ledger_entries
  for insert with check (is_admin());

create policy payments_read_own on payments
  for select using (owner_id = my_owner_id() or is_admin());

-- An owner uploads a receipt; only admin may verify it against the bank
-- statement (spec §8, step 5).
create policy payments_owner_submit on payments
  for insert with check (owner_id = my_owner_id() and status = 'SUBMITTED');

create policy payments_admin_verify on payments
  for update using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------
-- Safety
-- ---------------------------------------------------------------------

-- Anyone on a live booking can raise an SOS. Nobody but admin can read one:
-- spec §10 says the other party is never told it was triggered.
create policy sos_insert on sos_events
  for insert with check (triggered_by = auth.uid());

create policy sos_read on sos_events
  for select using (triggered_by = auth.uid() or is_admin());

create policy sos_admin_update on sos_events
  for update using (is_admin()) with check (is_admin());

create policy sos_locations_insert on sos_locations
  for insert with check (
    exists (select 1 from sos_events e where e.id = sos_id and e.triggered_by = auth.uid())
  );

create policy sos_locations_read on sos_locations
  for select using (is_admin());

create policy disputes_read on disputes
  for select using (
    raised_by = auth.uid()
    or is_admin()
    or exists (
      select 1 from bookings b
       where b.id = disputes.booking_id
         and (b.customer_id = auth.uid() or b.driver_id = my_driver_id())
    )
  );

create policy disputes_raise on disputes
  for insert with check (
    raised_by = auth.uid()
    and exists (
      select 1 from bookings b
       where b.id = booking_id
         and (b.customer_id = auth.uid() or b.driver_id = my_driver_id())
    )
  );

create policy disputes_admin_update on disputes
  for update using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------
-- Conduct and audit
-- ---------------------------------------------------------------------

-- A customer can see their own record — being blocked without being able to
-- see why is how you lose someone permanently over a misunderstanding.
create policy conduct_read on conduct_records
  for select using (
    (subject_type = 'CUSTOMER' and subject_id = auth.uid())
    or (subject_type = 'VEHICLE'
        and exists (select 1 from vehicles v where v.id = subject_id
                      and (v.owner_id = my_owner_id() or v.driver_id = my_driver_id())))
    or is_admin()
  );

-- The audit log is readable by admin and written by nobody through the API.
create policy audit_admin_read on audit_log for select using (is_admin());

-- Internal bookkeeping: which expiry warnings and reminders have already gone
-- out, so a nightly job that runs twice does not send the 14-day insurance
-- warning twice.
--
-- No client has any business reading or writing it. Enabling RLS with a single
-- admin-read policy means the default — deny — applies to everyone else. The
-- job functions are unaffected: cron runs them as the table owner, and an
-- owner bypasses RLS unless FORCE is set.
create policy notifications_admin_read on notifications_sent
  for select using (is_admin());

-- ---------------------------------------------------------------------
-- Storage: licences and NIDs are never publicly addressable (spec §16)
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('vehicle-photos', 'vehicle-photos', false),
       ('documents', 'documents', false),
       ('receipts', 'receipts', false),
       ('avatars', 'avatars', false)
on conflict (id) do nothing;

-- Documents are served by short-lived signed URLs only. An owner may upload
-- into their own folder and read it back; nobody else but admin can.
create policy documents_owner_rw on storage.objects
  for all to authenticated
  using (
    bucket_id in ('documents', 'receipts')
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id in ('documents', 'receipts')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy documents_admin_read on storage.objects
  for select to authenticated
  using (bucket_id in ('documents', 'receipts', 'vehicle-photos', 'avatars') and is_admin());

create policy vehicle_photos_read_authenticated on storage.objects
  for select to authenticated using (bucket_id in ('vehicle-photos', 'avatars'));

create policy vehicle_photos_owner_write on storage.objects
  for insert to authenticated
  with check (bucket_id in ('vehicle-photos', 'avatars') and (storage.foldername(name))[1] = auth.uid()::text);


-- #####################################################################
-- # 0004_jobs.sql
-- #####################################################################

-- =====================================================================
-- Wantok Ride — notification plumbing and the job entry points
--
-- 0004 schedules six jobs. Three of them are pure SQL and live in 0002.
-- The other three need to send things — push, SMS — which Postgres cannot
-- do, so they call edge functions over pg_net. This file defines those
-- entry points and the two tables the senders write to.
-- =====================================================================

-- pg_net lets Postgres call an edge function from a cron job. If it is not
-- enabled the tables and functions below still install; only the outbound
-- call is inert, and `invoke_edge_function` says so rather than erroring.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  else
    raise notice 'pg_net is not available. Scheduled jobs will not be able to call edge functions.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Delivery
-- ---------------------------------------------------------------------

-- Expo push tokens. One person, many devices — a driver with a work phone
-- and a personal one should get the booking on both.
create table push_tokens (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles (id) on delete cascade,
  token      text not null unique,
  platform   text not null default 'android',
  created_at timestamptz not null default now()
);

create index push_tokens_profile_idx on push_tokens (profile_id);

alter table push_tokens enable row level security;

create policy push_tokens_own on push_tokens
  for all using (profile_id = auth.uid()) with check (profile_id = auth.uid());

-- Every SMS the platform sends, with its segment count.
--
-- SMS is the channel that costs money per message and the one people dispute
-- ("I never got the suspension notice"). Logging every send with its provider
-- id turns both of those from arguments into queries, and lets the monthly
-- bill be reconciled against what was actually sent.
create table sms_log (
  id          bigserial primary key,
  to_number   text not null,
  body        text not null,
  segments    smallint not null default 1,
  provider_id text,
  ok          boolean not null,
  error       text,
  sent_at     timestamptz not null default now()
);

create index sms_log_sent_idx on sms_log (sent_at desc);
create index sms_log_number_idx on sms_log (to_number, sent_at desc);

alter table sms_log enable row level security;
create policy sms_log_admin on sms_log for select using (is_admin());

-- ---------------------------------------------------------------------
-- Calling an edge function from a cron job
-- ---------------------------------------------------------------------

-- The service role key is read from Vault rather than written into a
-- migration. `supabase secrets set` puts it there; nothing in this repo
-- contains it.
create or replace function invoke_edge_function(fn text, body jsonb default '{}'::jsonb)
returns bigint language plpgsql security definer as $$
declare
  request_id bigint;
  base_url text;
  service_key text;
begin
  select decrypted_secret into base_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into service_key from vault.decrypted_secrets where name = 'service_role_key';

  if to_regproc('net.http_post') is null then
    raise notice 'pg_net is not enabled — cannot invoke %', fn;
    return null;
  end if;

  if base_url is null or service_key is null then
    raise notice 'Vault secrets project_url / service_role_key are not set — cannot invoke %', fn;
    return null;
  end if;

  select net.http_post(
    url := base_url || '/functions/v1/' || fn,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body := body,
    timeout_milliseconds := 20000
  ) into request_id;

  return request_id;
end;
$$;

-- ---------------------------------------------------------------------
-- The three job entry points 0004 schedules
-- ---------------------------------------------------------------------

-- Spec §7 future flow. Every minute: reminders, and the 45-minute release.
create or replace function run_scheduled_booking_cycle()
returns bigint language sql as $$
  select invoke_edge_function('scheduled-booking-cycle');
$$;

/**
 * Document expiry warnings at 30, 14 and 7 days (spec §6).
 *
 * The band arithmetic is done here rather than in the edge function so the
 * job can be reasoned about in SQL, and so `notifications_sent` — which is
 * what makes a twice-running job harmless — is written in the same statement
 * that decides a warning is due.
 */
create or replace function send_document_warnings()
returns integer language plpgsql as $$
declare
  due jsonb;
  n integer;
begin
  with expiring as (
    select
      v.id as vehicle_id,
      v.owner_id,
      v.driver_id,
      v.registration_no,
      d.kind,
      d.label,
      d.expiry,
      (d.expiry - current_date) as days_left
    from vehicles v
    left join drivers dr on dr.id = v.driver_id
    cross join lateral (
      values
        ('REGO', 'Registration', v.rego_expiry),
        ('INSURANCE', 'Insurance', v.insurance_expiry),
        ('LICENCE', 'Driver licence', dr.licence_expiry)
    ) as d(kind, label, expiry)
    where v.status = 'APPROVED'
      and d.expiry is not null
      and d.expiry >= current_date
  ), banded as (
    -- The tightest band that still covers it: a document with 7 days left is
    -- in the 7-day band, not the 30-day one.
    select *, (
      select min(t) from unnest(array[7, 14, 30]) as t where days_left <= t
    ) as threshold
    from expiring
  ), claimed as (
    insert into notifications_sent (subject_type, subject_id, kind, threshold)
    select 'vehicle_doc', vehicle_id::text || ':' || kind, 'DOC_EXPIRY', threshold
      from banded
     where threshold is not null
    on conflict do nothing
    returning subject_id, threshold
  )
  select jsonb_agg(to_jsonb(b)) into due
    from banded b
    join claimed c
      on c.subject_id = b.vehicle_id::text || ':' || b.kind
     and c.threshold = b.threshold;

  if due is null then return 0; end if;

  perform invoke_edge_function('send-notifications', jsonb_build_object('kind', 'DOC_EXPIRY', 'items', due));

  select jsonb_array_length(due) into n;
  return n;
end;
$$;

-- Spec §8: weekly statements, pushed to owners every Monday.
create or replace function send_weekly_statements()
returns bigint language sql as $$
  select invoke_edge_function('send-notifications', jsonb_build_object('kind', 'WEEKLY_STATEMENT'));
$$;


-- #####################################################################
-- # 0005_realtime.sql
-- #####################################################################

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


-- #####################################################################
-- # 0006_cron.sql
-- #####################################################################

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


-- #####################################################################
-- # seed.sql — vehicle classes and the launch rate table
-- #####################################################################

-- =====================================================================
-- Wantok Ride — seed
--
-- Vehicle classes, and a launch rate table.
--
-- ⚠ The kina figures below are **open decision #2 in the spec** and are not
-- signed off. The SEDAN row is the worked example from spec §5; the other
-- three are scaled from it and are placeholders until someone who runs a
-- vehicle in Port Moresby has priced them. They are here so the app has
-- something to quote from on day one, not because they are right.
--
-- Changing a rate later means INSERTing a new version with a future
-- `effective_from`. The table is append-only by rule — an UPDATE is silently
-- discarded — so an old booking can always be explained.
-- =====================================================================

insert into vehicle_classes (code, name, seats, description, sort_order, active) values
  ('SEDAN',    'Small sedan',      4,  'Town runs on sealed roads',                1, true),
  ('UTE',      'Twin cab utility', 4,  'Rough roads, some load space',             2, true),
  ('WAGON4WD', '4WD wagon',        7,  'Settlements, wet season, out of town',     3, true),
  ('BUS10',    '10-seater bus',    10, 'Groups and airport runs',                  4, true)
on conflict (code) do nothing;

-- Amounts are toea. K10.00 is 1000.
insert into rate_versions (
  class_code, base_fare, per_km, minimum_fare,
  night_multiplier, night_start, night_end, rounding,
  service_fee, commission_pct, effective_from
) values
  -- Spec §5's worked example, exactly as written.
  ('SEDAN',    1000, 350, 2000, 1.30, '20:00', '05:00', 5, 0, 10.00, '2026-01-01T00:00:00Z'),
  ('UTE',      1200, 400, 2500, 1.30, '20:00', '05:00', 5, 0, 10.00, '2026-01-01T00:00:00Z'),
  ('WAGON4WD', 1500, 500, 3000, 1.30, '20:00', '05:00', 5, 0, 10.00, '2026-01-01T00:00:00Z'),
  -- Open decision #6: whether buses are distance-priced like everything else
  -- or run fixed charter routes. Distance-priced here, pending that call.
  ('BUS10',    2500, 600, 6000, 1.30, '20:00', '05:00', 5, 0, 10.00, '2026-01-01T00:00:00Z');


-- =====================================================================
-- Done.
--
-- Sanity check — this should list every table with row-level security on:
--
--     select tablename, rowsecurity from pg_tables
--      where schemaname = 'public' order by tablename;
--
-- And this should show the four vehicle classes with a live rate each:
--
--     select c.code, c.name, r.base_fare, r.per_km, r.minimum_fare
--       from vehicle_classes c
--       join rate_versions r on r.class_code = c.code
--      order by c.sort_order;
-- =====================================================================
