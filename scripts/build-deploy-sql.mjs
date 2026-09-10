/**
 * Concatenate the migrations and the seed into one file.
 *
 * `supabase db push` is the right way to deploy this. But it needs the CLI
 * linked to the project, which needs an access token scoped to the right
 * organisation and the database password — and there are perfectly ordinary
 * situations where someone has the dashboard open and not those.
 *
 * So this produces `supabase/deploy.sql`: paste it into the SQL Editor, run
 * it once, and the database is built. Same statements, same order, no CLI.
 *
 *     npm run build:deploy
 *
 * It is generated, not hand-edited — the migrations remain the source of
 * truth, and this is rebuilt from them.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'supabase', 'migrations');

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

const parts = [
  `-- =====================================================================
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
-- Generated ${new Date().toISOString()}
-- Source: ${files.length} migrations + seed.sql
-- =====================================================================
`,
];

for (const file of files) {
  const body = await readFile(join(migrationsDir, file), 'utf8');
  parts.push(`
-- #####################################################################
-- # ${file}
-- #####################################################################

${body.trim()}
`);
}

const seed = await readFile(join(root, 'supabase', 'seed.sql'), 'utf8');
parts.push(`
-- #####################################################################
-- # seed.sql — vehicle classes and the launch rate table
-- #####################################################################

${seed.trim()}
`);

parts.push(`
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
`);

const out = join(root, 'supabase', 'deploy.sql');
await writeFile(out, parts.join('\n'));

const lines = parts.join('\n').split('\n').length;
console.log(`Wrote supabase/deploy.sql — ${files.length} migrations + seed, ${lines} lines`);
