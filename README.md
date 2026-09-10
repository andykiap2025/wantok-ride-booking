# Wantok Ride

A two-sided marketplace connecting passengers with privately owned,
admin-approved vehicles in Port Moresby. Built to
[`docs/spec.md`](docs/spec.md) v1.0.

**Skyworks Systems.** The platform owns no vehicles and never touches the fare —
the passenger pays the driver in cash, and Wantok Ride earns 10% commission,
settled separately by the vehicle owner.

---

## What makes this different from a taxi app

Three decisions from the spec drive almost every design choice in the codebase.
If you read nothing else, read these:

**The customer picks the vehicle.** There is no dispatch algorithm anywhere in
this repository. A passenger sees the real cars near them — the make, the
colour, the plate, the driver's face and rating, the photographs — and chooses
one. When a driver declines, the passenger goes back to that list *with that
vehicle removed and the fare unchanged*. The platform never silently reassigns.

**The fare is locked at booking.** Computed once, from a versioned rate table,
stored on the booking row, and never recomputed. Traffic, detours and a longer
actual route do not change it. That is what lets two people settle up in cash at
the side of a road in Boroko without an argument.

**Registration is deliberately slow.** Physical inspection at Skyworks, a
fourteen-point checklist, six photographs at six specified angles, and current
registration, insurance and licence. It is the platform's main trust asset, and
the code is written to stop it being automated away later.

---

## Layout

```
packages/core/       The domain engine — every business rule, zero dependencies
supabase/            Schema, RLS, triggers, cron, edge functions
apps/mobile/         Expo — customer and driver apps, one codebase
apps/admin/          React web console — approvals, rates, live board, SOS
docs/                Written procedures the spec requires before launch
```

### `packages/core` — the engine

The fare calculation, the booking state machine, the commission ledger, the
review blind window, the expiry bands, the release timings. Plain JavaScript, no
dependencies, no I/O, `now` always passed in.

The same functions run on the handset, in the Supabase edge functions and in the
tests, so there is exactly one implementation of "what is this trip worth" and
one of "may this booking be cancelled".

```bash
npm test          # 147 tests
```

They encode the spec's own worked examples, so a failure can be checked against
the document by hand rather than against another piece of code. The ones worth
knowing about:

- Night boundaries — inclusive at 20:00, exclusive at 05:00, wrapping midnight,
  and evaluated in **Port Moresby time, not the handset's**
- The minimum fare applied *before* the night multiplier — the order is set by
  spec §5 and is worth K10 a trip
- Commission on the locked fare, not the metered fare
- A rate table older than 24 hours refuses to quote rather than guessing

### `supabase/` — the database

```
migrations/0001_schema.sql      Tables, constraints, indexes
migrations/0002_functions.sql   Triggers, views, nightly jobs
migrations/0003_rls.sql         Row-level security, deny by default
migrations/0006_cron.sql        Six scheduled jobs
migrations/0004_jobs.sql        Push tokens, SMS log, job entry points
functions/                      Edge functions (Deno)
seed.sql                        Vehicle classes and the launch rate table
```

Run against a throwaway Postgres with `npm run test:db` — it builds a cluster
in a temp directory, applies every migration and the seed, then runs 46
assertions covering what only the database can enforce. It needs no Docker and
never touches the live project.

That exercise is not decorative. It found three real bugs before deployment: a
`postgis` extension declared but never used, a trip counter that incremented on
a replayed completion, and a unique constraint that would have refused every
owner payment after the first.

Three things the database owns outright, so no client can get them wrong:

- **`vehicles.balance_owed` is derived from `ledger_entries`**, maintained by
  trigger and refused as a direct write. If a balance is ever wrong, an entry is
  wrong, and the entry can be shown to the owner.
- **`rate_versions` is append-only** — a rule discards UPDATEs and DELETEs, so a
  fare from March can still be explained in September.
- **A vehicle cannot reach `APPROVED`** without six photographs, a passing
  inspection and three unexpired documents. The console shows every blocker; the
  trigger is what makes it true.

### `apps/mobile` — the two apps

One codebase, two Play Store listings. `EXPO_PUBLIC_VARIANT` selects which shell
mounts. They share the engine, the design system, the Supabase client, chat,
rating and SOS.

```bash
cp apps/mobile/.env.example apps/mobile/.env   # fill it in
npm run mobile
```

Expo SDK 57, React Native 0.86, New Architecture.

### `apps/admin` — the console

```bash
cp apps/admin/.env.example apps/admin/.env
npm run admin
```

Live board, approvals with the inspection checklist, payment verification, the
versioned rate editor, disputes, the SOS log and the decline-reason reports.

It signs in with the **anon key and the staff member's own session** — there is
no privileged key in the browser. Admin powers come from `is_admin()` branches
in the RLS policies, so revoking someone is a change to one array in one row,
not a key rotation.

---

## Setup

```bash
npm install
npm test                     # 147 engine tests
npm run test:db              # migrations + 47 behaviour tests, throwaway Postgres
```

### Deploying the database

Two routes. Both end in the same place.

**With the CLI**, if it is linked to the project:

```bash
supabase link --project-ref <ref>
supabase db push             # migrations 0001–0006
psql "$DATABASE_URL" -f supabase/seed.sql
```

**Without it** — paste-and-run, for when the dashboard is open and the CLI is
not linked:

```bash
npm run build:deploy         # writes supabase/deploy.sql
```

Then paste `supabase/deploy.sql` into the SQL Editor and run it once. It is
every migration in order followed by the seed, generated from the same files,
and it has been verified against a virgin Postgres: 23 tables, 50 RLS
policies, 4 vehicle classes, 4 live rates.

After it runs, paste `supabase/tests/02-verify-deployment.sql` into the same
editor. It is read-only and safe against production, and returns one row per
check — PASS, WARN or FAIL with the actual number beside it, so "it seemed to
work" becomes a list you can read in ten seconds. A healthy deployment has no
FAILs.

Either way, first enable **pg_cron** and **pg_net** under Database →
Extensions. Neither is fatal if missing — the schema installs regardless and
reports what it skipped — but the scheduled half of the product (expiry sweep,
booking reminders, the 45-minute release, weekly statements, retention) does
not run without them.

Then set two Vault secrets so the cron jobs can reach the edge functions:
`project_url` and `service_role_key`.

### Deploying the functions

```bash
npm run sync:core            # vendor the engine into functions/
supabase functions deploy
```

Secrets the edge functions need (`supabase secrets set`):

| Key | What for |
|---|---|
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` | SMS — open decision #7 |
| `ONCALL_PHONE` | The SOS on-call number — **open decision #4, not yet chosen** |
| `TRACK_BASE_URL` | Where trip-sharing links point |

And in Vault, for the cron jobs: `project_url`, `service_role_key`.

### Google Maps

Enable Directions, Geocoding, Places and Maps SDK for Android. Restrict the key
to the app's package name and SHA-1, and **set a daily quota cap before the
first APK ships** — spec §13 rule 7, and the list screen is where costs run
away.

The cost discipline is in `services/maps.js` and enforced there rather than left
to whoever writes the next screen: haversine ordering on the handset, one
Directions call per booking attempt, a pickup ETA only when a vehicle is tapped,
a ten-minute route cache, a ten-vehicle cap, and every displayed ETA padded 30%.

---

## Decisions taken that were open in the spec

The spec lists ten open decisions (§21). Three of them had to be answered to
build anything; the rest are still open and are flagged in the code where they
bite.

**#1 Branding — proposed, not signed off.** Gold (`#FCD116`, the bird of
paradise on the PNG flag) carries every call to action; near-black is the brand
surface; **red is reserved for SOS, cancellations and errors and nothing else.**

That last part is the actual argument. The source design kit ran red as both the
brand colour and the stop colour — which is fine until the product has an SOS
button, at which point red has stopped meaning anything. The palette is in
`apps/mobile/src/theme/colors.js` and changing one token changes the app.

The logo in `components/Logo.js` is a stand-in built to the right proportions:
two points joined by a road, because *wantok* means "one talk" — your kin, the
people you can rely on — and the product is the connection between two people,
not a car.

**#2 Kina figures — placeholders.** The SEDAN row is the spec's own worked
example (K10 base, K3.50/km, K20 minimum, ×1.30 at night, rounded up to K5, 10%
commission). The other three classes are scaled from it and are marked as
unsigned-off in `supabase/seed.sql`. The rate editor previews four real Port
Moresby trips as you type, so replacing them is a five-minute job for someone
who knows what a run to Gerehu is worth.

**#6 Bus pricing — distance-based**, like everything else, pending that call.

Still open and unanswered: the debt ceiling per owner tier (#3), **the SOS
on-call roster (#4 — a launch blocker, see `docs/sos-escalation.md`)**,
inspection fees (#5), the SMS provider (#7), whether licence class is checked
against vehicle class (#8), corporate accounts (#9), and **the insurance
position with MVIL on whether approved vehicles are covered for fare-paying
passengers (#10)**.

That last one is worth saying plainly: it is a question about whether the
vehicles on this platform are legally covered to carry paying passengers, and no
amount of software answers it.

---

## Against the build phases

| Phase | State |
|---|---|
| 1 Foundation — schema, RLS, OTP, storage, audit | ✅ |
| 2 Vehicle onboarding — docs, photos, inspection, expiry | ✅ |
| 3 Rates — classes, versioning, editor, fare engine + tests | ✅ |
| 4 Driver presence — online/offline, reporting, staleness | ✅ |
| 5 Booking core — list, profile, quote, countdown, state machine | ✅ |
| 6 Live trip — tracking, status, breadcrumbs | ⚠️ trip-sharing page not built |
| 7 Money — ledger, ceiling, receipts, verification | ⚠️ weekly statement sender not built |
| 8 Trust — two-way reviews, blind window, flags | ✅ |
| 9 Safety and comms — SOS, emergency contact, chat, calls | ⚠️ SOS roster is a launch blocker |
| 10 Scheduled bookings — reminders, re-confirm, release | ✅ |
| 11 Admin console — board, disputes, reporting | ✅ |
| 12 Hardening and pilot | ⬜ not started |

Everything not built is listed in [`AGENTS.md`](AGENTS.md) rather than left to be
discovered.

---

## Before the first paying passenger

Not code. From spec §10 and §17:

- [ ] **A named on-call phone and a roster.** An SOS button with nobody on the
      other end is worse than no button.
- [ ] **Fire a real SOS on a real trip** and time it end to end.
- [ ] The written refund, suspension and review-moderation policies.
- [ ] The privacy statement — the platform holds licence and NID numbers.
- [ ] **The insurance position, confirmed in writing.**
- [ ] Google Cloud daily quota alarm.
- [ ] 8–12 approved vehicles on one or two corridors. An empty map kills a
      marketplace faster than a missing feature.

---

## A note on the photography

The onboarding and welcome images in `apps/mobile/assets/backgrounds/` are Port
Moresby — Fairfax Harbour, the carved figure, the ridges. They came from the
source design plates and they are the right images for this product.

Two of them show vehicles carrying a **green livery from a different brand**.
That is fine for a prototype and not fine for a Play Store listing. Re-shoot or
re-livery `onboard-vehicle.jpg` and `onboard-ride.jpg` before publishing.
