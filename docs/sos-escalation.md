# SOS escalation procedure

**This document is a launch blocker.** Spec §10:

> An SOS button with nobody on the other end is worse than no button. Before
> launch there must be a named on-call phone, a roster, and a written
> escalation procedure.

The software is built. What is below is the part that is not software, and it
is the part that decides whether the button is worth anything.

---

## Before launch — decisions still open

These are open decision #4 in the spec and are **not filled in**:

| Decision | Owner | Status |
|---|---|---|
| The on-call number | Skyworks | ⬜ Not decided |
| Who is on it, and when | Skyworks | ⬜ No roster |
| Out-of-hours arrangement | Skyworks | ⬜ Not decided |
| Local police station numbers, by area | Skyworks | ⬜ Not collected |
| Who may authorise a refund after an incident | Skyworks | ⬜ Not decided |

Until the first two are answered, `ONCALL_PHONE` has nowhere to point and the
SOS feature should be considered incomplete regardless of what the code does.

---

## What happens automatically

The moment someone holds SOS for three seconds, without any human involvement:

1. **The admin console alarms.** Loud, repeating, and it cannot be dismissed
   without an acknowledgement and a typed note.
2. **The on-call phone gets an SMS** naming the role, the booking reference and
   the vehicle registration.
3. **The emergency contact of whoever triggered it gets an SMS** with the
   vehicle, the driver's name and number, and a live location link.
4. **Location streams every 10 seconds for 60 minutes**, whatever the app is
   doing — backgrounded, locked, or in a pocket.
5. **A frozen audit record is written**, kept indefinitely.

Two things that deliberately do **not** happen:

- **The trip is not cancelled.** Nothing changes on either phone.
- **The other party is never told.** A passenger who pressed SOS because of the
  driver must not have the driver's phone light up about it.

---

## What the on-call person does

Target: **acknowledge within 2 minutes.** The console shows a running clock and
the SOS log reports the median, so this is measured, not aspirational.

### 1. Acknowledge (within 2 minutes)

Open the console. The alarm bar carries the passenger's and driver's numbers as
one-tap call buttons. Acknowledging requires typing what you did — that is
intentional, and it is the record that matters afterwards.

### 2. Call the person who triggered it

The console says which of the two it was. Call them first.

- **They answer and are fine** — most alerts will be this. Note it and resolve.
- **They answer and are not fine** — stay on the line. Go to step 4.
- **No answer** — call again once, then go to step 3.

### 3. Call the other party

If the passenger triggered and does not answer, call the driver. Ask where the
vehicle is and whether the passenger is with them. Compare what they say against
the live location trail on the console.

**If the driver's account and the location trail disagree, treat it as a real
incident and go to step 4 immediately.**

### 4. Call the police

**000**, or the station nearest the last known position. Have ready:

- The live location link from the console
- Vehicle registration, make, model, colour
- Driver's full name and phone number
- Passenger's full name and phone number
- The booking reference

### 5. Call the emergency contact

They have already had the automated SMS. Ring them with what you know. Do not
speculate.

### 6. Write it up

Before the end of the shift, in the SOS record: what happened, who was called,
what time, and what the outcome was. This record has no expiry and may be read
by people who are not this company.

---

## Escalation ladder

| Elapsed | Action |
|---|---|
| 0 min | Automated: alarm, SMS to on-call and emergency contact, streaming begins |
| 2 min | On-call acknowledges in the console |
| 5 min | Both parties called |
| 10 min | Police called if either is unreachable or the accounts do not match |
| 30 min | Skyworks management notified, whatever the outcome |
| Next day | Written up and reviewed at the operations meeting |

---

## Roster requirements

- **One named person, always.** Not "the ops team". A rota with a name against
  every hour.
- **A phone that is answered.** Not a desk line after 17:00.
- **A handover.** The outgoing person tells the incoming one about anything
  still open.
- **A backup.** If the on-call does not acknowledge within 5 minutes, the alert
  goes to a second number. That escalation is not yet built — see below.

---

## Known gaps

Honest list, for the launch checklist:

1. **No second-line escalation.** If the on-call phone is off, the SMS goes
   nowhere and only the console alarm remains. A second number after 5
   minutes unacknowledged is a small addition to `sos-trigger` and should be
   made before launch.
2. **No test drill.** Fire a real SOS from a real handset on a real trip before
   the first paying passenger, and time it end to end.
3. **Police numbers are not in the console.** Currently the procedure says
   "000 or the local station" and the local station numbers have not been
   collected. They should be a table in the console, by area.
4. **The tracking link in the SOS SMS is not yet built.** `sos-trigger` composes
   a URL under `TRACK_BASE_URL`; the page that serves it needs building
   alongside the trip-sharing page (spec §10).
