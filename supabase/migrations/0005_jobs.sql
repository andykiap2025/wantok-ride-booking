-- =====================================================================
-- Wantok Ride — notification plumbing and the job entry points
--
-- 0004 schedules six jobs. Three of them are pure SQL and live in 0002.
-- The other three need to send things — push, SMS — which Postgres cannot
-- do, so they call edge functions over pg_net. This file defines those
-- entry points and the two tables the senders write to.
-- =====================================================================

create extension if not exists pg_net;

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
