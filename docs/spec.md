# Wantok Ride — Build Specification

**Product:** Wantok Ride
**Owner:** Skyworks Systems
**Market:** Port Moresby first, then other PNG centres
**Status:** Specification v1.0 — for build
**Date:** September 2026

---

## 1. Purpose and scope

Wantok Ride is a two-sided marketplace connecting passengers with privately owned, admin-approved
vehicles for point-to-point trips. The platform does not own vehicles and does not
handle passenger money. It earns 10% commission on every booking it generates.

### In scope for v1

- Point-to-point trips priced on distance
- Customer chooses a specific vehicle from a list of available vehicles
- Fixed price quoted and locked at the moment of booking
- Cash paid directly by the passenger to the driver
- Admin-set rate tables per vehicle class, with a separate night rate
- Owner and vehicle registration with physical inspection and document approval
- Immediate bookings and future (scheduled) bookings
- Two-way reviews and ratings
- In-app messaging and direct calling
- SOS for both passenger and driver
- Commission ledger with automatic delisting at a debt ceiling

### Explicitly out of scope for v1

- Hourly and daily hire (removed from the plan)
- Self-drive hire
- Card or mobile-money payment of fares
- Automatic dispatch or driver auto-matching (the customer picks)
- Fare splitting, shared rides, package delivery
- Multi-currency, multi-country

### Deferred but designed for

- A service fee line in the rate table, set to zero at launch
- Corporate accounts with monthly invoicing
- Charter pricing for buses

---

## 2. Business model

| Item | Decision |
|---|---|
| Revenue | 10% of the locked quoted fare on every completed booking |
| Fare payment | Cash, passenger to driver, off-platform |
| Commission collection | Accrues to a vehicle balance, settled by the owner via bank transfer or mobile money |
| Delisting | Vehicle hidden from customers when balance exceeds its ceiling |
| Default ceiling | K100, adjustable per owner by admin |
| Free period | First 60 days from vehicle approval, no commission accrued |
| Cancellations / no-shows | No commission charged, but logged |
| Rate setting | Admin only. Owners cannot set their own prices |

The 10% is presented to owners as a launch rate, not a permanent one.

---

## 3. Actors and permissions

| Actor | Description |
|---|---|
| **Customer** | Passenger. Signs up by phone number, books trips, reviews drivers |
| **Driver** | Operates one vehicle. May or may not be the owner. Accepts or declines bookings |
| **Owner** | Registers one or more vehicles, pays commission, sees earnings and balance |
| **Admin** | Skyworks staff. Approves vehicles, sets rates, handles disputes and SOS |
| **Super admin** | Andy. Everything admin can do, plus rate tables, commission rates, ceilings, staff accounts |

An owner may also be a driver. The account carries both roles rather than
requiring two logins.

---

## 4. Application structure

Three apps on one shared backend.

**Customer App** (Play Store, public)
Book a trip, track it, message and call the driver, review, raise a dispute, SOS.

**Driver App** (Play Store, public, but useless until a vehicle is approved)
Go online, receive and confirm bookings, navigate, mark trips complete, SOS,
see earnings and the commission owed. Includes the owner view for owners who
also drive.

**Admin App / Console**
Approvals, rate tables, live board of active trips, disputes, SOS alerts,
commission ledger and settlements, reporting. Best as a web console for desk
work, with a lightweight mobile view for SOS and approvals on the go.

---

## 5. Vehicle classes and rate table

### Classes at launch

| Code | Class | Seats | Typical use |
|---|---|---|---|
| `SEDAN` | Small sedan | 4 | Town runs, sealed roads |
| `UTE` | Twin cab utility | 4 | Rough roads, some load space |
| `WAGON4WD` | 4WD wagon | 6–7 | Settlements, wet season, out-of-town |
| `BUS10` | 10-seater bus | 10 | Groups, airport runs |

Classes must be data, not hard-coded, so a new class can be added by admin.

### Rate table fields, per class

| Field | Example | Notes |
|---|---|---|
| `base_fare` | K10.00 | Charged on every trip |
| `per_km` | K3.50 | Applied to estimated route distance |
| `minimum_fare` | K20.00 | Floor for short trips |
| `night_multiplier` | 1.30 | Applied to the whole fare |
| `night_start` | 20:00 | |
| `night_end` | 05:00 | |
| `rounding` | 5 | Round final fare up to nearest K5 |
| `service_fee` | K0.00 | Reserved, shown separately, zero at launch |
| `commission_pct` | 10.00 | Per class, so it can be tuned |
| `effective_from` | timestamp | Rates are versioned, never overwritten |

Rates are fetched from the backend at booking time. Never bake a price into an
APK. Keep the full history of rate versions so an old booking can always be
explained.

### Fare calculation

```
distance_km   = route distance from pickup to destination (Google Directions)
raw           = base_fare + (per_km × distance_km)
raw           = max(raw, minimum_fare)
if booking time falls inside the night window:
    raw       = raw × night_multiplier
fare          = round_up_to_nearest(raw, rounding)
commission    = fare × commission_pct / 100
```

**Rules**

1. The fare is calculated once, at booking, and locked. Traffic, detours and
   route changes do not change it.
2. Day or night is decided by the **trip start time**, not the booking time. A
   trip scheduled for 21:00 is a night fare even if booked at noon.
3. A trip that starts before the night window ends stays on the day rate for its
   whole duration.
4. Commission is charged on the locked fare, not on the cash actually collected.
   A driver who gives a discount is spending his own margin.
5. Both fare and commission are displayed to the driver as separate lines.

---

## 6. Owner and vehicle onboarding

Registration is deliberately slow and manual. This is the platform's main trust
asset and should not be automated away.

### Steps

1. **Owner account created** in the app. Name, phone (OTP verified), NID or
   passport, address, bank details for settlements.
2. **Vehicle submitted** in the app. Class, make, model, year, colour,
   registration number, seats.
3. **Documents uploaded.** Current registration papers, insurance certificate,
   driver's licence (front and back), driver's photo, driver's phone number.
4. **Photos uploaded.** Minimum six: front, rear, both sides, front interior,
   rear interior. Enforce the count and the angles in the UI.
5. **Physical inspection booked.** The vehicle is brought to Skyworks. Admin
   completes a checklist and takes their own photos.
6. **Admin decision.** Approved, rejected with reason, or approved with
   conditions and a re-inspection date.
7. **Vehicle goes live.** Free period starts. Owner and driver are notified.

### Inspection checklist (admin app)

Tyres, brakes, lights and indicators, seatbelts for every seat, windscreen,
doors and locks, interior cleanliness, air conditioning, spare tyre and jack,
odometer reading, bodywork condition, registration matches papers, insurance
current, driver licence current and class-appropriate.

Each item is pass / fail / note. A failed critical item (brakes, seatbelts,
lights, insurance, licence) blocks approval.

### Expiry tracking

Registration, insurance and licence all carry expiry dates. The system warns
admin and the owner at 30, 14 and 7 days, then **automatically suspends the
vehicle** on the expiry date until a new document is uploaded and approved.
This is not optional. An expired-insurance vehicle carrying a paying passenger
is the platform's biggest liability.

---

## 7. Booking lifecycle

### States

```
DRAFT                  customer is choosing, nothing committed
REQUESTED              customer confirmed, waiting on driver
CONFIRMED              driver accepted
DECLINED               driver declined with a reason (terminal for this vehicle)
EXPIRED                driver did not respond in time (terminal for this vehicle)
DRIVER_EN_ROUTE        driver heading to pickup
ARRIVED                driver at pickup point
IN_PROGRESS            passenger on board, trip started
COMPLETED              driver marked complete, fare due in cash
CANCELLED_BY_CUSTOMER
CANCELLED_BY_DRIVER
NO_SHOW_CUSTOMER       driver waited the grace period, passenger absent
NO_SHOW_DRIVER         driver confirmed but never arrived
DISPUTED               raised by either side, admin handling
```

### Immediate booking flow

1. Customer sets pickup (map pin or current location) and destination.
2. App returns the list of available vehicles, nearest first, each showing
   class, photo, driver name, rating, straight-line distance, and the quoted
   fare for that class.
3. Customer taps a vehicle. Now, and only now, the app calls Directions to get
   a real route ETA and confirms the exact fare.
4. Customer sees the full vehicle and driver profile with reviews, then confirms.
5. Booking moves to `REQUESTED`. The driver gets a push with a **90-second
   countdown** to accept or decline.
6. On accept, `CONFIRMED`. Contact details unlock for both sides.
7. On decline or timeout, the customer is returned to the list with that vehicle
   removed, the fare still held, and a prompt to pick another. Do not silently
   reassign — the customer chose this vehicle deliberately.

### Future booking flow

Same as above, but the customer sets a date and time. Additional rules:

- Minimum lead time 1 hour, maximum 14 days.
- Driver receives the request immediately and has **30 minutes** to accept.
- Reminder to the driver at 18:00 the evening before, with a re-confirm button.
- Reminder to the driver 60 minutes before pickup, with a re-confirm button.
- If the driver has not re-confirmed 45 minutes before pickup, the booking is
  released and the customer is notified immediately with a prompt to rebook from
  the available list. Never let a scheduled booking fail silently on the morning.
- Late release counts as a driver no-show against the vehicle's record.

### Cancellation and no-show rules

| Event | Rule |
|---|---|
| Customer cancels before driver accepts | Free, not logged |
| Customer cancels after `CONFIRMED` | Logged against the customer |
| Customer cancels after `DRIVER_EN_ROUTE` | Logged, counts double |
| Driver cancels after accepting | Logged against the vehicle |
| Customer no-show | Driver waits 10 minutes at pickup, then marks no-show |
| Driver no-show | Customer can mark it 15 minutes after the agreed time |
| Commission | Never charged on any of the above |

Three driver cancellations or no-shows in a rolling 7 days triggers an admin
review flag. Three customer no-shows in 30 days blocks new bookings until the
customer speaks to admin.

### Decline reasons (driver, required)

- Too far from pickup
- Destination road not suitable for my vehicle
- I will not travel to that area at this time
- Vehicle problem
- Already on another job
- Other (free text, required)

Decline reasons are logged and reported. They are how you find out which suburbs
are underserved and at which hours.

---

## 8. Commission ledger and settlement

Each vehicle carries a running balance.

**Credits (increase balance owed):** 10% of each `COMPLETED` booking's locked fare.
**Debits (reduce balance owed):** owner payments confirmed by admin.

### Flow

1. Trip completes. A ledger entry is written against the vehicle: booking ID,
   date, fare, commission, running balance.
2. When the balance reaches 80% of the ceiling, the owner and driver get a
   warning notification.
3. When the balance exceeds the ceiling, the vehicle's status becomes
   `SUSPENDED_UNPAID`. It disappears from customer search. Bookings already
   confirmed are honoured.
4. Owner pays by bank transfer or mobile money and uploads a receipt photo in
   the app.
5. Admin verifies against the bank statement and marks the payment received. The
   balance clears and the vehicle relists automatically.

Weekly statements are pushed to owners every Monday: trips, gross fares,
commission, payments received, closing balance. The owner should never need to
ask what they owe.

Reuse the manual bank-transfer receipt flow already built for HireCar Pro.

---

## 9. Reviews and ratings

Two-way, and neither side sees the other's rating until both have submitted or
48 hours have passed. This stops retaliation.

**Customer rates the driver:** 1–5 stars, optional comment, optional tags
(clean vehicle, safe driving, on time, polite, took a long route, vehicle not as
pictured).

**Driver rates the customer:** 1–5 stars, optional comment, optional tags (ready
on time, respectful, paid correct fare, kept me waiting, did not pay full fare).

Rules:
- Only a `COMPLETED` booking can be reviewed.
- One review per booking per side.
- Vehicle profile shows average rating, trip count, and the most recent reviews.
- Customer rating is visible to drivers when a booking request comes in.
- A vehicle whose average drops below 3.0 over its last 20 trips is flagged for
  admin review.
- Admin can hide a review that is abusive, but the action is logged and the
  rating is recalculated.

---

## 10. Safety and SOS

### Emergency contacts

Every customer and every driver must register an emergency contact name and
phone number at signup. This is **mandatory, not a settings-screen option**, and
the number is verified with a test SMS before the account can book or drive.

### SOS behaviour

Available to both passenger and driver, on screen throughout any active trip.
Held for 3 seconds to fire, to avoid pocket triggers.

On trigger, simultaneously:

1. **Admin alert.** Loud, repeating, on the admin console and the on-call admin
   phone. Cannot be dismissed without acknowledgement and a note.
2. **SMS to the emergency contact** of whoever triggered it. Plain SMS, not push,
   because the contact will not have the app. Contains: who triggered it, booking
   reference, vehicle registration, driver name and phone, live location link.
3. **Location streaming** every 10 seconds for the next 60 minutes regardless of
   app state.
4. **Full audit record** with everything known about the booking, frozen at that
   moment.

An SOS never cancels the trip and never tells the other party it was triggered.

### On-call requirement

An SOS button with nobody on the other end is worse than no button. Before
launch there must be a named on-call phone, a roster, and a written escalation
procedure (acknowledge within 2 minutes, call the passenger, call the driver,
call police on 000 or the local station number). Document this and keep it
beside the console.

### Trip sharing

From `IN_PROGRESS`, the customer can send a live tracking link by SMS or
WhatsApp to anyone. The link is a plain web page, no app or login needed, and it
expires 2 hours after the trip ends.

---

## 11. Communication

Order of preference, deliberately: **call first, chat second.**

- **Call button.** Opens the phone dialler. Numbers are exchanged only after
  `CONFIRMED` and only for the duration of that booking plus 24 hours. Number
  masking through a virtual number is a nice-to-have, not v1.
- **In-app chat.** Text only, per booking, closes 24 hours after completion.
  Messages stored server-side and visible to admin during a dispute. Keep it
  light: no images, no voice notes, no typing indicators. Data costs money here.
- **Quick replies** on both sides to cut typing: "I'm outside", "5 minutes away",
  "What colour is the vehicle?", "I'm at the gate".

---

## 12. Notifications

| Event | Customer | Driver | Owner | Admin |
|---|---|---|---|---|
| Booking requested | — | Push + sound | — | — |
| Booking confirmed | Push | — | — | — |
| Declined / expired | Push | — | — | — |
| Driver en route | Push | — | — | — |
| Driver arrived | Push + sound | — | — | — |
| Trip completed | Push | Push | — | — |
| Future booking reminder | Push (2h) | Push (evening + 1h) | — | — |
| Booking released | Push + SMS | Push | — | Alert |
| SOS | — | — | — | Alarm |
| Balance at 80% | — | Push | Push | — |
| Vehicle suspended | — | Push | Push + SMS | — |
| Document expiring | — | Push | Push | Alert |
| New review | Push | Push | — | — |
| Dispute update | Push | Push | — | — |

Anything involving money or a failed booking goes by SMS as well as push. Push
alone is not reliable enough on PNG networks.

---

## 13. Maps, ETAs and API cost control

Google Maps is the only realistic provider for PNG coverage, and it bills per
call. The list screen is where costs run away.

**Rules**

1. Order the vehicle list by **straight-line (haversine) distance**, computed
   locally. Zero API cost.
2. Call the Directions API only for the **route the customer is actually
   quoting**, that is, pickup to destination, once per booking attempt.
3. Call Directions for a **driver-to-pickup ETA only when the customer taps a
   specific vehicle**, not for every vehicle in the list.
4. Cache the pickup-to-destination route for 10 minutes so a customer comparing
   vehicles does not re-bill the same route.
5. Cap the list at the 10 nearest vehicles.
6. Pad displayed ETAs by 30%. Google's traffic data for Port Moresby is thin and
   an optimistic ETA that keeps slipping is worse than an honest one.
7. Set a daily quota alarm on the Google Cloud project from day one.

**Driver location reporting:** every 15 seconds while online and idle, every 5
seconds during an active trip, and not at all when offline. A driver who has not
reported in 10 minutes is automatically marked offline and drops off the
customer list. Stale vehicles on the list are the fastest way to lose customers.

---

## 14. Network resilience

Assume patchy coverage and expensive data. Follow the offline-first pattern
already used across the other Skyworks apps.

- Local SQLite mirror of the user's own bookings, profile and rate table.
- Rate table cached with its version stamp; refreshed on app open and before any
  quote. A quote is never produced from a rate table older than 24 hours.
- Driver actions (accept, arrived, start, complete) queue locally and sync when
  the connection returns, with the real timestamp preserved.
- Location pings buffer and upload in batches when offline.
- Photo uploads during registration resume rather than restart.
- The customer app must clearly show "searching" versus "no connection". They
  are different problems and the user needs to know which one they have.
- Booking creation requires a live connection. Do not allow an offline booking
  that the driver never receives.

---

## 15. Data model

Core tables. Supabase / Postgres, with row-level security.

**profiles** — `id`, `phone` (unique), `full_name`, `role[]`, `photo_url`,
`emergency_contact_name`, `emergency_contact_phone`, `emergency_verified_at`,
`rating_avg`, `rating_count`, `status`, `created_at`

**owners** — `id`, `profile_id`, `nid_number`, `address`, `bank_name`,
`bank_account`, `settlement_method`, `created_at`

**drivers** — `id`, `profile_id`, `licence_number`, `licence_class`,
`licence_expiry`, `licence_front_url`, `licence_back_url`, `verified_at`

**vehicles** — `id`, `owner_id`, `driver_id`, `class_code`, `make`, `model`,
`year`, `colour`, `registration_no` (unique), `seats`, `status`,
`rego_expiry`, `insurance_expiry`, `insurance_doc_url`, `rego_doc_url`,
`approved_at`, `approved_by`, `free_period_ends_at`, `commission_ceiling`,
`balance_owed`, `rating_avg`, `rating_count`, `trips_completed`

Vehicle `status`: `DRAFT`, `PENDING_DOCS`, `PENDING_INSPECTION`, `APPROVED`,
`REJECTED`, `SUSPENDED_UNPAID`, `SUSPENDED_DOCS`, `SUSPENDED_ADMIN`, `RETIRED`

**vehicle_photos** — `id`, `vehicle_id`, `angle`, `url`, `uploaded_by`, `created_at`

**inspections** — `id`, `vehicle_id`, `inspector_id`, `inspected_at`,
`checklist` (jsonb), `odometer`, `result`, `notes`, `recheck_due`

**vehicle_classes** — `code`, `name`, `seats`, `description`, `icon_url`, `sort_order`, `active`

**rate_versions** — `id`, `class_code`, `base_fare`, `per_km`, `minimum_fare`,
`night_multiplier`, `night_start`, `night_end`, `rounding`, `service_fee`,
`commission_pct`, `effective_from`, `created_by`

**driver_status** — `driver_id`, `vehicle_id`, `is_online`, `lat`, `lng`,
`heading`, `last_ping_at`

**bookings** — `id`, `reference`, `customer_id`, `vehicle_id`, `driver_id`,
`state`, `is_scheduled`, `scheduled_for`, `pickup_lat`, `pickup_lng`,
`pickup_label`, `dest_lat`, `dest_lng`, `dest_label`, `distance_km`,
`rate_version_id`, `is_night_rate`, `quoted_fare`, `commission_amount`,
`requested_at`, `confirmed_at`, `en_route_at`, `arrived_at`, `started_at`,
`completed_at`, `cancelled_at`, `cancelled_by`, `cancel_reason`,
`decline_reason`, `created_at`

**booking_locations** — `id`, `booking_id`, `lat`, `lng`, `recorded_at`
(trip breadcrumb trail, retained 90 days)

**messages** — `id`, `booking_id`, `sender_id`, `body`, `sent_at`, `read_at`

**reviews** — `id`, `booking_id`, `author_id`, `subject_type`, `subject_id`,
`stars`, `comment`, `tags[]`, `visible`, `hidden_by`, `created_at`

**ledger_entries** — `id`, `vehicle_id`, `booking_id`, `entry_type`, `amount`,
`balance_after`, `note`, `created_by`, `created_at`

**payments** — `id`, `owner_id`, `amount`, `method`, `reference`,
`receipt_url`, `status`, `verified_by`, `verified_at`, `created_at`

**sos_events** — `id`, `booking_id`, `triggered_by`, `role`, `lat`, `lng`,
`triggered_at`, `acknowledged_by`, `acknowledged_at`, `resolution`, `notes`

**disputes** — `id`, `booking_id`, `raised_by`, `category`, `description`,
`status`, `assigned_to`, `resolution`, `resolved_at`, `created_at`

**audit_log** — `id`, `actor_id`, `action`, `entity_type`, `entity_id`,
`before` (jsonb), `after` (jsonb), `created_at`

### Key integrity rules

- A booking always stores `rate_version_id` and the computed `quoted_fare`. Never
  recompute a historical fare from current rates.
- `vehicles.balance_owed` is derived from `ledger_entries`, never edited directly.
- A vehicle cannot move to `APPROVED` without a passing inspection, six photos,
  and unexpired rego, insurance and licence.
- Contact details are exposed by a database view that checks for an active
  booking between the two parties.

---

## 16. Security and access control

- Phone-number OTP sign-in for all roles, no passwords. Six digits, 5-minute
  expiry, maximum 3 attempts, then a 15-minute lockout.
- Row-level security in Supabase. A customer reads only their own bookings; a
  driver reads only bookings for their vehicle; an owner reads only their own
  vehicles and ledger.
- Documents and photos in a private storage bucket, served by short-lived signed
  URLs. Licences and NIDs are never publicly addressable.
- Admin actions on approvals, suspensions, ledger adjustments, review hiding and
  refunds are all written to `audit_log`.
- Admin console requires a second factor.
- Retention: trip breadcrumbs 90 days, messages 12 months, financial records
  7 years, SOS records indefinitely.

---

## 17. Admin operations

Admin is a staffed function, not just a screen. Before launch, decide who does
each of these and write the policy down.

**Daily:** approve pending vehicles, verify owner payments, clear the dispute
queue, review flagged drivers and customers, watch the live board.

**Weekly:** send owner statements, review decline-reason and cancellation
reports, check expiring documents.

**Written policies needed before launch:**
- Refund and fare-dispute policy, and who may authorise what
- Suspension policy: what earns a warning, what earns removal
- SOS escalation procedure and on-call roster
- Review moderation rules
- Data and privacy statement, since you hold licences and NID numbers

**Dispute categories:** fare disagreement, driver behaviour, customer behaviour,
vehicle condition, no-show, safety incident, payment not made, other. Each has a
target response time; 24 hours for most, immediate for safety.

---

## 18. Technical stack

Consistent with the existing Skyworks portfolio.

| Layer | Choice |
|---|---|
| Mobile apps | React Native / Expo |
| Local store | SQLite, offline-first sync |
| Backend | Supabase (Postgres, Auth, Storage, Realtime) |
| Realtime | Supabase Realtime for driver positions and booking state |
| Admin console | React web app on Railway |
| Maps | Google Maps SDK, Directions API, Geocoding API |
| Push | Expo Notifications |
| SMS | Local aggregator or Twilio, for OTP, SOS and critical alerts |
| Distribution | Google Play, closed testing first |

Build with the usual phased Claude Code prompts and a CLAUDE.md anchor file per
app, committing between phases.

---

## 19. Build phases

**Phase 1 — Foundation.** Supabase schema, RLS, OTP auth, profiles and roles,
storage buckets, audit log.

**Phase 2 — Vehicle onboarding.** Owner registration, vehicle submission,
document and photo upload, admin approval queue, inspection checklist, expiry
tracking and auto-suspension.

**Phase 3 — Rates.** Vehicle classes, versioned rate tables, admin rate editor,
fare calculation engine with unit tests covering night boundaries, minimum fares
and rounding.

**Phase 4 — Driver presence.** Driver app shell, online/offline, location
reporting, staleness timeout, driver home screen.

**Phase 5 — Booking core.** Pickup and destination selection, available-vehicle
list, vehicle profile, quote and lock, request, accept/decline with countdown,
full state machine, trip completion.

**Phase 6 — Live trip.** Map tracking, status updates, arrival, breadcrumbs,
trip-sharing link.

**Phase 7 — Money.** Commission ledger, balance and ceiling, auto-suspension,
receipt upload, admin verification, weekly statements.

**Phase 8 — Trust.** Two-way reviews with the 48-hour blind window, ratings,
cancellation and no-show tracking, flagging rules.

**Phase 9 — Safety and comms.** SOS on both sides, emergency contact
verification, admin alarm console, SMS integration, in-app chat and call buttons.

**Phase 10 — Scheduled bookings.** Future booking, reminder and re-confirm
cycle, release-and-notify logic.

**Phase 11 — Admin console.** Live board, disputes, reporting, staff accounts.

**Phase 12 — Hardening and pilot.** Offline behaviour, load testing, Play Store
closed testing with a small verified fleet in one corridor.

---

## 20. Launch plan note

Do not launch citywide. Start with 8 to 12 approved vehicles across the classes,
concentrated on one or two corridors where you can guarantee a customer gets a
ride. An empty map kills a marketplace faster than a missing feature.

---

## 21. Open decisions

1. Branding: logo, colour palette, tagline, Play Store listing copy
2. Actual kina figures for each class in the rate table
3. Debt ceiling per owner tier, and whether any owners pre-load credit instead
4. Who is on the SOS on-call phone, and the roster
5. Whether inspections are free or carry a one-off fee
6. Bus pricing: distance-based like the rest, or fixed charter routes
7. SMS provider and cost per message
8. Whether the driver's licence class is checked against the vehicle class
9. Corporate accounts: in the roadmap or not
10. Insurance position, confirmed in writing with MVIL or a broker, on whether
    the approved vehicles are covered for fare-paying passengers
