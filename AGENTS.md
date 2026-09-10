# Wantok Ride — working notes

Anchor file for anyone (or anything) writing code in this repo. Read this
before the first edit.

---

## The one rule

**Every business rule lives in `packages/core`, and nowhere else.**

The fare calculation, the booking state machine, the commission ledger, the
review blind window, the document expiry bands, the release timings — all of it
is plain JavaScript with no dependencies and no I/O, and all of it is imported
by the customer app, the driver app, the admin console and the Supabase edge
functions.

If you find yourself writing `if (booking.state === 'CONFIRMED')` in a screen,
stop. The question you are asking is a domain question and it has an answer in
`core` already, or it needs one.

Two consequences worth spelling out:

- **`core` never reads a clock.** `now` is always a parameter. That is what
  makes it testable, and what lets a driver's offline tap be replayed later with
  the timestamp it actually happened at.
- **`core` never touches the network.** No Supabase import, no fetch. If a
  function needs data, it takes it as an argument.

Run `npm test` after any change to it. 147 tests, and they encode the spec's own
worked examples — a failure can be checked against the document by hand.

---

## Expo has changed

Read the exact versioned docs at <https://docs.expo.dev/versions/v57.0.0/>
before writing anything that touches an Expo module. SDK 57 with React Native
0.86 and the New Architecture on.

Specific things that have already bitten this project:

- **`react-native-maps` paints nothing** under RN 0.86's New Architecture — it
  mounts, reports no error, and draws an empty rectangle, markers included.
  The map in `components/Map.js` is raster tiles and SVG for that reason. Do
  not swap it back without testing on a device.
- **Android is edge-to-edge by default** since SDK 54. Every screen needs
  `edges={['top','bottom']}` on `SafeAreaView`, or `insets.bottom` added to the
  padding of anything that floats over the map. Without it, footers sit under
  the navigation bar.
- **The monorepo needs `metro.config.js`.** `@wantok/core` is a workspace
  symlink; Metro does not follow those by default. If the app suddenly cannot
  resolve it, that file is why.

---

## Layout

```
packages/core/       The domain engine. Zero dependencies. 147 tests.
supabase/
  migrations/        Schema, RLS, triggers, cron. Numbered, run in order.
  functions/         Edge functions (Deno). `_shared/core` is generated.
  seed.sql           Vehicle classes and the launch rate table.
apps/mobile/         Expo. Two Play Store variants from one codebase.
apps/admin/          Vite + React. The staffed console.
docs/                Written procedures the spec requires before launch.
```

### The generated copy

`supabase/functions/_shared/core/` is a **copy** of `packages/core/src`, made by
`npm run sync:core`. Supabase only deploys the `functions/` directory, so the
package cannot be imported across the workspace.

Never edit the copy. It is stamped with a header saying so, and the next sync
will silently undo your work. Edit the package and re-run the sync.

---

## Things that are enforced in more than one place, on purpose

These look like duplication and are not. In each case the app copy exists to
make the UI honest, and the database copy exists because the UI cannot be
trusted:

| Rule | In the app | In the database |
|---|---|---|
| Booking transitions | greys out the button | `booking-transition` edge function, atomic against the row's real state |
| Review blind window | hides the review | RLS policy on `reviews` |
| Contact details window | disables the call button | `booking_contacts` view |
| Approval requirements | lists every blocker | `vehicle_guard_approval` trigger, raises |
| Balance from ledger | displays it | `ledger_set_balance` trigger owns it |

If you change one side, change the other.

---

## Money

Everything inside the engine is **integer toea** (1 kina = 100 toea). Money that
has been through a float is money you cannot reconcile against a bank statement.

Convert at the edges — `toToea` on the way in, `formatKina` on the way out — and
never in between. The database columns are integers for the same reason.

---

## Red

`colors.danger` is reserved for SOS, cancellations, suspensions and form errors.
Nothing else in the product is red.

This is a safety decision, not an aesthetic one. The source design kit used red
as both the brand colour and the stop colour, which means that by the time an
SOS button is red, red has stopped meaning anything. Gold carries every call to
action here so that red can keep its meaning.

---

## Time

Port Moresby is **UTC+10, no daylight saving**. The night-rate window, the 18:00
reminder and every displayed time are evaluated in Moresby local time via
`pngLocalParts`, not in the handset's timezone.

A phone left on Brisbane time would otherwise price an 05:30 airport run as a
night fare, and the app and the driver would disagree about money in front of
a passenger.

---

## What is not built

Kept honest rather than buried:

- **The trip-sharing web page.** `TRACK_BASE_URL/t/:token` — the app composes
  and shares the link; the page that serves it does not exist yet. Same for the
  SOS location page.
- **Second-line SOS escalation.** See `docs/sos-escalation.md`.
- **Push token registration.** The `push_tokens` table and the sender exist;
  the app does not yet register a token on sign-in.
- **`send-notifications` edge function.** Referenced by the document-expiry and
  weekly-statement jobs in `0004_jobs.sql`; not written.
- **Admin MFA.** Spec §16 requires a second factor on the console. Enforced at
  the Supabase project level, not yet switched on.
