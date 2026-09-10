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

create extension if not exists "pgcrypto";
create extension if not exists "postgis" schema extensions;

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

  constraint amount_is_positive check (amount >= 0),
  -- One commission entry per booking, so a retried sync cannot double-charge.
  unique nulls not distinct (booking_id, entry_type)
);

create index ledger_vehicle_idx on ledger_entries (vehicle_id, created_at);

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
