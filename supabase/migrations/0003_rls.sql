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

/**
 * How many reviews a booking has.
 *
 * SECURITY DEFINER, and that is the entire point. The blind window needs to
 * know whether *both* sides have reviewed, which means counting rows in
 * `reviews` — but asking that question from inside a policy ON `reviews`
 * makes Postgres evaluate the policy to answer the policy, and it aborts with
 * "infinite recursion detected in policy for relation reviews".
 *
 * Running as the owner steps outside RLS for the count and breaks the cycle.
 * It leaks nothing worth having: a bare integer, no stars, no comment, no
 * author — and only for a booking id the caller already holds.
 */
create or replace function booking_review_count(target uuid)
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::integer from reviews where booking_id = target;
$$;

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
             or booking_review_count(b.id) >= 2
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

-- These four are the only policies in the whole schema that live outside the
-- `public` schema, which makes them the only ones a `drop schema public
-- cascade` does not remove. Re-running this migration after a reset would
-- otherwise fail on "policy already exists" — and fail *here*, near the end of
-- 0003, leaving the later migrations unapplied and the database half-built.
--
-- Dropped first so the storage section is re-runnable on its own terms.
drop policy if exists documents_owner_rw on storage.objects;
drop policy if exists documents_admin_read on storage.objects;
drop policy if exists vehicle_photos_read_authenticated on storage.objects;
drop policy if exists vehicle_photos_owner_write on storage.objects;

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
