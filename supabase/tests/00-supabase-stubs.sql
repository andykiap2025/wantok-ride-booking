-- Minimal stand-ins for what a Supabase project provides.
--
-- This is NOT part of the product. It exists so the real migrations can be
-- run against a plain Postgres cluster and their SQL actually verified,
-- rather than shipped unexecuted.

create schema if not exists auth;
create schema if not exists storage;
create schema if not exists vault;
create schema if not exists extensions;

-- auth.users — bookings and profiles reference it.
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  phone text
);

-- auth.uid() — every RLS policy calls it.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- storage.buckets / storage.objects — 0003 inserts buckets and adds policies.
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text not null,
  owner uuid
);

alter table storage.objects enable row level security;

create or replace function storage.foldername(name text)
returns text[] language sql immutable as $$
  select string_to_array(name, '/');
$$;

-- vault.decrypted_secrets — read by invoke_edge_function in 0005.
create table if not exists vault.decrypted_secrets (
  name text primary key,
  decrypted_secret text
);

-- The three roles every Supabase project has. The storage policies grant to
-- `authenticated`, and 0007 grants table privileges to all three.
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
end $$;

-- pg_cron and pg_net are Supabase-managed extensions and cannot be installed
-- into a throwaway cluster. Stubbing the two functions the migrations call
-- means everything around them — the job definitions, the schedules, the
-- entry-point functions — is still executed and verified.
create schema if not exists cron;
create schema if not exists net;

create or replace function cron.schedule(job text, sched text, cmd text)
returns bigint language sql as $$ select 1::bigint $$;

create or replace function net.http_post(
  url text,
  headers jsonb default '{}',
  body jsonb default '{}',
  timeout_milliseconds int default 5000
) returns bigint language sql as $$ select 1::bigint $$;
