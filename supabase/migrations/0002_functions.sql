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

  update vehicles set trips_completed = trips_completed + 1 where id = new.vehicle_id;
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

-- Scheduled with pg_cron in 0004_cron.sql. Kept as plain functions so they
-- can also be run by hand from the console during the pilot.
