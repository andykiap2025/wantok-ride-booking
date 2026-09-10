-- =====================================================================
-- Wantok Ride — table privileges
--
-- Runs last, because it grants on objects every earlier migration created.
--
-- Why this file exists at all
-- --------------------------
-- Row-level security only ever *restricts*. It filters rows a role can
-- already reach; it cannot grant reach. So a table with perfect policies and
-- no GRANT returns "permission denied for table" to every caller, and the
-- app is dead in a way that looks nothing like a permissions bug — the anon
-- key is correct, the policies are correct, and every request 401s.
--
-- A fresh Supabase project sets these grants up for you. A project where
-- `public` has been dropped and recreated does not: dropping the schema takes
-- the grants and the default privileges with it, and `grant all on all tables`
-- only affects tables that exist at the moment it runs. Run it before the
-- migrations and it silently grants nothing.
--
-- Both of those are easy to hit and neither announces itself, so the grants
-- live here as a migration rather than as a step in a README nobody re-reads.
--
-- The posture
-- -----------
-- Deliberately tighter than the Supabase default, which grants ALL to `anon`.
--
--   anon           SELECT only. A signed-out handset needs the vehicle
--                  classes and the live rate table to show prices before
--                  anyone logs in, and nothing else. It cannot write.
--   authenticated  SELECT, INSERT, UPDATE, DELETE — with RLS deciding every
--                  row. This is the real security boundary.
--   service_role   Everything. Used only by edge functions, never shipped.
--
-- No DELETE reaches the ledger or SOS records regardless: those carry DO
-- INSTEAD NOTHING rules (spec §16 keeps financial records 7 years and SOS
-- records indefinitely).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Schema access
-- ---------------------------------------------------------------------

grant usage on schema public to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Existing objects
-- ---------------------------------------------------------------------

grant select on all tables in schema public to anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;

-- bigserial primary keys — audit_log, booking_locations, sos_locations,
-- sms_log, notifications_sent. Without USAGE on the sequence an INSERT fails
-- at the default, which reads as a permissions error on a column nobody
-- supplied.
grant usage, select on all sequences in schema public to anon, authenticated, service_role;

-- Postgres grants EXECUTE on functions to PUBLIC by default, so this is
-- belt-and-braces rather than strictly required. It matters if that default
-- is ever revoked, because `is_admin()` is called by nearly every policy.
grant execute on all functions in schema public to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Future objects
-- ---------------------------------------------------------------------
--
-- The grants above cover what exists right now. Default privileges cover the
-- next table someone adds — without them, a migration six months from now
-- creates a table nobody can read and the cause is a long way from the
-- symptom.

alter default privileges in schema public grant select on tables to anon;
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant all on tables to service_role;

alter default privileges in schema public
  grant usage, select on sequences to anon, authenticated, service_role;

alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------
--
-- Covered by `all tables` above, but named explicitly because they are the
-- two the apps depend on and a silent failure here is expensive:
--
--   listable_vehicles  the customer's list of cars. Empty means "no vehicles
--                      available", which is indistinguishable from a quiet
--                      night and would be debugged in the wrong place.
--   booking_contacts   the phone numbers. `security_invoker` means the
--                      caller's own RLS applies to the underlying tables, so
--                      granting select here widens nothing.

grant select on listable_vehicles to anon, authenticated, service_role;
grant select on booking_contacts to authenticated, service_role;
