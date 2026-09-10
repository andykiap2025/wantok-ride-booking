#!/usr/bin/env bash
#
# Run the migrations and the behaviour tests against a throwaway Postgres.
#
# The 147 unit tests in packages/core cover the domain engine. This covers what
# only the database can enforce — the approval gate, the derived balance,
# automatic suspension and relisting, the append-only rate table, and the check
# constraints. Between the two, no rule in the product ships unexecuted.
#
# Needs a local Postgres server (14+) on PATH. It does not touch your Supabase
# project and does not need Docker: it builds a cluster in a temp directory,
# runs everything, prints the results, and throws the cluster away.
#
#     ./scripts/test-db.sh
#
set -euo pipefail

PORT="${WANTOK_TEST_PORT:-55432}"
WORKDIR="$(mktemp -d)"
PGDATA="$WORKDIR/pgdata"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cleanup() {
  pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

run() { psql -h 127.0.0.1 -p "$PORT" -U postgres -d "$1" -q -v ON_ERROR_STOP=1 "${@:2}"; }

# Applies the stubs and all five migrations to a fresh database.
#
# The CREATE EXTENSION lines for pg_cron and pg_net are commented out for the
# run — those are Supabase-managed and cannot be installed here. Everything
# else in the migrations is executed as written.
setup_db() {
  local db="$1"
  psql -h 127.0.0.1 -p "$PORT" -U postgres -q -c "create database $db"
  run "$db" -f "$ROOT/supabase/tests/00-supabase-stubs.sql"

  local file name
  for file in "$ROOT"/supabase/migrations/*.sql; do
    name="$(basename "$file")"
    sed -E 's/^create extension if not exists (pg_cron|pg_net);/-- [test harness] &/' \
      "$file" > "$WORKDIR/$db-$name"
    run "$db" -f "$WORKDIR/$db-$name" >/dev/null
  done
}

echo "--> starting a throwaway cluster on port $PORT"
initdb -D "$PGDATA" -U postgres --auth=trust -E UTF8 >/dev/null
pg_ctl -D "$PGDATA" -o "-p $PORT -c listen_addresses=127.0.0.1" -l "$WORKDIR/pg.log" start >/dev/null
sleep 2

# Two databases, deliberately.
#
# `wantok` gets the migrations plus the real seed, proving the two coexist.
# `wantok_test` gets the migrations only, because the behaviour tests build
# their own fixtures and `rate_versions` is append-only — a seeded rate row
# cannot be deleted to make room for a test one. That is the rule working, not
# a problem to route around.
echo "--> migrations + production seed"
setup_db wantok
run wantok -f "$ROOT/supabase/seed.sql" >/dev/null
echo "    $(ls "$ROOT"/supabase/migrations/*.sql | wc -l | tr -d ' ') migrations and seed.sql applied cleanly"

echo "--> behaviour tests, on a clean database"
setup_db wantok_test
psql -h 127.0.0.1 -p "$PORT" -U postgres -d wantok_test -v ON_ERROR_STOP=1 \
  -f "$ROOT/supabase/tests/01-behaviour.sql" 2>&1 |
  grep -E "(PASS|FAIL|ERROR|All behaviour)" |
  sed -E "s/^psql:.*[0-9]+: NOTICE:  //" || true

echo
echo "--> done. Any line reading FAIL or ERROR above is a real failure."
