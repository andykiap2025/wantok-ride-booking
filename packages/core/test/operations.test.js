/**
 * Scheduling, dispatch, safety and auth (spec §7 future flow, §10, §11,
 * §13, §16).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  earliestSlot,
  eveningBefore,
  formatPickup,
  pendingReconfirm,
  releaseDeadline,
  reminderSchedule,
  shouldRelease,
  validateScheduledTime,
} from '../src/scheduling.js';
import {
  availableVehicles,
  createRouteCache,
  explainEmptyList,
  isPresenceFresh,
  routeCacheKey,
  withoutVehicle,
} from '../src/dispatch.js';
import { haversineKm, padEtaSeconds, formatDuration, formatDistanceKm, pointAlong } from '../src/geo.js';
import {
  contactWindowOpen,
  createChallenge,
  formatPngMobile,
  isValidPngMobile,
  normalisePhone,
  OtpError,
  validateEmergencyContact,
  verifyOtp,
} from '../src/auth.js';
import {
  acknowledge,
  buildSosEvent,
  emergencyContactSms,
  isStreaming,
  isTripShareValid,
  SosRole,
  streamPlan,
} from '../src/sos.js';
import { BookingState, Thresholds, VehicleStatus } from '../src/constants.js';
import { makeBooking, makeVehicle, pngTime, PLACES, SEDAN_RATE } from './fixtures.js';

const iso = (s) => new Date(s).toISOString();

// =========================================================================
// Scheduling
// =========================================================================

const NOW = pngTime(2026, 9, 10, 12, 0);

test('scheduled rides need at least an hour of lead time', () => {
  assert.equal(validateScheduledTime(pngTime(2026, 9, 10, 12, 30), NOW).ok, false);
  assert.equal(validateScheduledTime(pngTime(2026, 9, 10, 13, 0), NOW).ok, true);
});

test('scheduled rides cannot be more than 14 days out', () => {
  assert.equal(validateScheduledTime(pngTime(2026, 9, 24, 11, 0), NOW).ok, true);
  assert.equal(validateScheduledTime(pngTime(2026, 9, 25, 13, 0), NOW).ok, false);
});

test('the too-soon message points the customer at booking now instead', () => {
  const verdict = validateScheduledTime(pngTime(2026, 9, 10, 12, 15), NOW);
  assert.match(verdict.error, /book now/i);
});

test('the earliest offered slot is rounded up to a clean 5 minutes', () => {
  const from = pngTime(2026, 9, 10, 12, 3);
  assert.equal(earliestSlot(from).toISOString(), pngTime(2026, 9, 10, 13, 5).toISOString());
});

test('the evening reminder is 18:00 Port Moresby the day before pickup', () => {
  const pickup = pngTime(2026, 9, 14, 7, 30);
  assert.equal(eveningBefore(pickup).toISOString(), pngTime(2026, 9, 13, 18, 0).toISOString());
});

test('a scheduled booking schedules both driver reminders and the release check', () => {
  const pickup = pngTime(2026, 9, 14, 7, 30);
  const booking = makeBooking({
    is_scheduled: true,
    scheduled_for: pickup.toISOString(),
    created_at: NOW.toISOString(),
  });
  const kinds = reminderSchedule(booking).map((r) => r.kind);
  assert.deepEqual(kinds, [
    'DRIVER_EVENING_REMINDER',
    'CUSTOMER_REMINDER',
    'DRIVER_HOUR_REMINDER',
    'RELEASE_CHECK',
  ]);
});

test('the release check sits 45 minutes before pickup', () => {
  const pickup = pngTime(2026, 9, 14, 7, 30);
  const booking = makeBooking({ is_scheduled: true, scheduled_for: pickup.toISOString() });
  assert.equal(releaseDeadline(booking).toISOString(), pngTime(2026, 9, 14, 6, 45).toISOString());
});

test('a booking the driver never re-confirmed is released, with time to rebook', () => {
  const pickup = pngTime(2026, 9, 14, 7, 30);
  const booking = makeBooking({
    state: BookingState.CONFIRMED,
    is_scheduled: true,
    scheduled_for: pickup.toISOString(),
    confirmed_at: NOW.toISOString(),
  });
  assert.equal(shouldRelease(booking, pngTime(2026, 9, 14, 6, 44)), false);
  assert.equal(shouldRelease(booking, pngTime(2026, 9, 14, 6, 45)), true);
});

test('a re-confirmation after the evening reminder holds the booking', () => {
  const pickup = pngTime(2026, 9, 14, 7, 30);
  const booking = makeBooking({
    state: BookingState.CONFIRMED,
    is_scheduled: true,
    scheduled_for: pickup.toISOString(),
    confirmed_at: NOW.toISOString(),
    reconfirmed_at: pngTime(2026, 9, 13, 19, 0).toISOString(),
  });
  assert.equal(shouldRelease(booking, pngTime(2026, 9, 14, 6, 50)), false);
});

test('an acceptance from six days earlier does not count as a re-confirmation', () => {
  // This is the whole point of the re-confirm cycle: a driver who said yes on
  // Monday and has ignored two reminders has not promised anything about
  // Friday morning.
  const pickup = pngTime(2026, 9, 14, 7, 30);
  const booking = makeBooking({
    state: BookingState.CONFIRMED,
    is_scheduled: true,
    scheduled_for: pickup.toISOString(),
    confirmed_at: NOW.toISOString(),
    reconfirmed_at: NOW.toISOString(), // when they accepted, days before
  });
  assert.equal(shouldRelease(booking, pngTime(2026, 9, 14, 6, 50)), true);
});

test('the re-confirm banner only appears inside its window, and turns urgent', () => {
  const pickup = pngTime(2026, 9, 14, 7, 30);
  const booking = makeBooking({
    state: BookingState.CONFIRMED,
    is_scheduled: true,
    scheduled_for: pickup.toISOString(),
    confirmed_at: NOW.toISOString(),
  });
  assert.equal(pendingReconfirm(booking, pngTime(2026, 9, 13, 12, 0)), null);
  assert.equal(pendingReconfirm(booking, pngTime(2026, 9, 13, 19, 0)).urgent, false);
  assert.equal(pendingReconfirm(booking, pngTime(2026, 9, 14, 6, 40)).urgent, true);
});

test('pickup times read the way a person would say them', () => {
  const now = pngTime(2026, 9, 10, 12, 0);
  assert.equal(formatPickup(pngTime(2026, 9, 10, 19, 15), now), 'Today, 7:15 PM');
  assert.equal(formatPickup(pngTime(2026, 9, 11, 7, 5), now), 'Tomorrow, 7:05 AM');
  assert.equal(formatPickup(pngTime(2026, 9, 13, 9, 0), now), 'Sunday, 9:00 AM');
  assert.equal(formatPickup(pngTime(2026, 9, 24, 6, 30), now), '24 Sep, 6:30 AM');
  assert.equal(formatPickup(pngTime(2026, 9, 11, 0, 30), now), 'Tomorrow, 12:30 AM');
});

// =========================================================================
// Dispatch and API cost control
// =========================================================================

const presenceAt = (vehicleId, place, minutesAgo = 0) => ({
  vehicle_id: vehicleId,
  driver_id: `drv-${vehicleId}`,
  is_online: true,
  lat: place.lat,
  lng: place.lng,
  last_ping_at: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
});

test('a driver who has not pinged in 10 minutes drops off the list', () => {
  assert.equal(isPresenceFresh(presenceAt('v1', PLACES.boroko, 9), NOW), true);
  assert.equal(isPresenceFresh(presenceAt('v1', PLACES.boroko, 11), NOW), false);
  assert.equal(isPresenceFresh({ ...presenceAt('v1', PLACES.boroko), is_online: false }, NOW), false);
});

test('the list is ordered by straight-line distance, nearest first', () => {
  const vehicles = [
    makeVehicle({ id: 'far', registration_no: 'AAA-111' }),
    makeVehicle({ id: 'near', registration_no: 'BBB-222' }),
  ];
  const list = availableVehicles({
    vehicles,
    presence: [presenceAt('far', PLACES.gerehu), presenceAt('near', PLACES.waigani)],
    rates: [SEDAN_RATE],
    pickup: PLACES.waigani,
    distanceKm: 6,
    startAt: NOW,
    now: NOW,
  });
  assert.deepEqual(list.map((r) => r.vehicle.id), ['near', 'far']);
  assert.ok(list[0].straightLineKm < list[1].straightLineKm);
});

test('the list is capped at ten, so Directions calls stay bounded', () => {
  const vehicles = Array.from({ length: 25 }, (_, i) => makeVehicle({ id: `v${i}`, registration_no: `R-${i}` }));
  const presence = vehicles.map((v, i) => presenceAt(v.id, { lat: PLACES.boroko.lat + i * 0.001, lng: PLACES.boroko.lng }));
  const list = availableVehicles({
    vehicles,
    presence,
    rates: [SEDAN_RATE],
    pickup: PLACES.boroko,
    distanceKm: 6,
    startAt: NOW,
    now: NOW,
  });
  assert.equal(list.length, Thresholds.MAX_VEHICLES_LISTED);
});

test('suspended and unapproved vehicles never appear', () => {
  const vehicles = [
    makeVehicle({ id: 'ok' }),
    makeVehicle({ id: 'unpaid', status: VehicleStatus.SUSPENDED_UNPAID }),
    makeVehicle({ id: 'docs', status: VehicleStatus.SUSPENDED_DOCS }),
    makeVehicle({ id: 'pending', status: VehicleStatus.PENDING_INSPECTION }),
  ];
  const list = availableVehicles({
    vehicles,
    presence: vehicles.map((v) => presenceAt(v.id, PLACES.boroko)),
    rates: [SEDAN_RATE],
    pickup: PLACES.boroko,
    distanceKm: 6,
    startAt: NOW,
    now: NOW,
  });
  assert.deepEqual(list.map((r) => r.vehicle.id), ['ok']);
});

test('a vehicle too small for the party is filtered out', () => {
  const vehicles = [makeVehicle({ id: 'sedan', seats: 4 })];
  const list = availableVehicles({
    vehicles,
    presence: [presenceAt('sedan', PLACES.boroko)],
    rates: [SEDAN_RATE],
    pickup: PLACES.boroko,
    distanceKm: 6,
    seatsNeeded: 7,
    startAt: NOW,
    now: NOW,
  });
  assert.equal(list.length, 0);
});

test('every row carries a price, computed from one shared route distance', () => {
  const list = availableVehicles({
    vehicles: [makeVehicle({ id: 'a' }), makeVehicle({ id: 'b' })],
    presence: [presenceAt('a', PLACES.boroko), presenceAt('b', PLACES.waigani)],
    rates: [SEDAN_RATE],
    pickup: PLACES.boroko,
    distanceKm: 6,
    startAt: NOW,
    now: NOW,
  });
  assert.equal(list[0].quote.fare, 3500);
  assert.equal(list[1].quote.fare, 3500);
});

test('a declined vehicle is removed and the customer keeps the same fare', () => {
  const list = availableVehicles({
    vehicles: [makeVehicle({ id: 'a' }), makeVehicle({ id: 'b' })],
    presence: [presenceAt('a', PLACES.boroko), presenceAt('b', PLACES.waigani)],
    rates: [SEDAN_RATE],
    pickup: PLACES.boroko,
    distanceKm: 6,
    startAt: NOW,
    now: NOW,
  });
  const after = withoutVehicle(list, 'a');
  assert.deepEqual(after.map((r) => r.vehicle.id), ['b']);
  assert.equal(after[0].quote.fare, list[0].quote.fare);
});

test('an empty list explains itself instead of just being empty', () => {
  const noneOnline = explainEmptyList({
    vehicles: [makeVehicle({ id: 'a' })],
    presence: [presenceAt('a', PLACES.boroko, 30)],
    seatsNeeded: 1,
    now: NOW,
  });
  assert.equal(noneOnline.code, 'NONE_ONLINE');
  assert.match(noneOnline.suggestion, /schedule/i);

  const tooSmall = explainEmptyList({
    vehicles: [makeVehicle({ id: 'a', seats: 4 })],
    presence: [presenceAt('a', PLACES.boroko)],
    seatsNeeded: 10,
    now: NOW,
  });
  assert.equal(tooSmall.code, 'SEATS');
});

test('the same route inside 10 minutes is not billed twice', () => {
  const cache = createRouteCache();
  const route = { distanceKm: 6.2, seconds: 900 };
  cache.set(PLACES.boroko, PLACES.airport, route, NOW);

  assert.deepEqual(cache.get(PLACES.boroko, PLACES.airport, new Date(NOW.getTime() + 9 * 60_000)), route);
  assert.equal(cache.get(PLACES.boroko, PLACES.airport, new Date(NOW.getTime() + 11 * 60_000)), null);
});

test('the route cache key rounds coordinates finer than anyone can tap', () => {
  const a = routeCacheKey({ lat: -9.44380, lng: 147.18030 }, PLACES.airport);
  const b = routeCacheKey({ lat: -9.443801, lng: 147.180302 }, PLACES.airport);
  assert.equal(a, b);
});

// =========================================================================
// Geometry
// =========================================================================

test('haversine gives plausible Port Moresby distances', () => {
  const km = haversineKm(PLACES.boroko, PLACES.airport);
  assert.ok(km > 3 && km < 6, `Boroko to Jacksons should be a few km, got ${km}`);
  assert.equal(haversineKm(PLACES.boroko, PLACES.boroko), 0);
});

test('every ETA shown to a user is padded by 30%', () => {
  assert.equal(padEtaSeconds(600), 780);
  assert.equal(padEtaSeconds(100, 0.3), 130);
});

test('durations and distances read naturally', () => {
  assert.equal(formatDuration(240), '4 min');
  assert.equal(formatDuration(20), '1 min'); // never "0 min"
  assert.equal(formatDuration(4200), '1 hr 10 min');
  assert.equal(formatDistanceKm(0.8), '800 m');
  assert.equal(formatDistanceKm(4.23), '4.2 km');
});

test('a car can be placed part-way along a route', () => {
  const path = [PLACES.boroko, PLACES.waigani, PLACES.airport];
  const start = pointAlong(path, 0);
  const end = pointAlong(path, 1);
  assert.deepEqual(start, PLACES.boroko);
  assert.ok(Math.abs(end.lat - PLACES.airport.lat) < 1e-9);
});

// =========================================================================
// Auth
// =========================================================================

test('PNG mobile numbers are recognised however they are typed', () => {
  assert.equal(normalisePhone('7412 8860'), '+67574128860');
  assert.equal(normalisePhone('+675 7412 8860'), '+67574128860');
  assert.equal(normalisePhone('675-7412-8860'), '+67574128860');
  assert.equal(isValidPngMobile('74128860'), true);
  assert.equal(isValidPngMobile('81234567'), true);
  assert.equal(isValidPngMobile('3211234'), false); // landline
  assert.equal(isValidPngMobile('741288601'), false); // too long
});

test('numbers are displayed the way they are read out', () => {
  assert.equal(formatPngMobile('+67574128860'), '7412 8860');
});

test('an OTP expires after five minutes', () => {
  const created = new Date('2026-09-10T00:00:00Z');
  const challenge = createChallenge({ phone: '74128860', code: '481902', now: created });
  assert.equal(verifyOtp(challenge, '481902', new Date('2026-09-10T00:04:59Z')).ok, true);
  const late = verifyOtp(challenge, '481902', new Date('2026-09-10T00:05:01Z'));
  assert.equal(late.ok, false);
  assert.equal(late.code, OtpError.EXPIRED);
});

test('three wrong attempts lock the challenge for fifteen minutes', () => {
  const created = new Date('2026-09-10T00:00:00Z');
  let challenge = createChallenge({ phone: '74128860', code: '481902', now: created });

  for (let i = 0; i < 2; i += 1) {
    const attempt = verifyOtp(challenge, '000000', created);
    assert.equal(attempt.code, OtpError.WRONG);
    challenge = attempt.challenge;
  }

  const third = verifyOtp(challenge, '000000', created);
  assert.equal(third.code, OtpError.LOCKED);
  challenge = third.challenge;

  // Even the right code is refused while locked.
  const duringLock = verifyOtp(challenge, '481902', new Date('2026-09-10T00:10:00Z'));
  assert.equal(duringLock.ok, false);
  assert.equal(duringLock.code, OtpError.LOCKED);
});

test('a code cannot be used twice', () => {
  const created = new Date('2026-09-10T00:00:00Z');
  const challenge = createChallenge({ phone: '74128860', code: '481902', now: created });
  const first = verifyOtp(challenge, '481902', created);
  assert.equal(first.ok, true);
  assert.equal(verifyOtp(first.challenge, '481902', created).code, OtpError.USED);
});

test('an emergency contact cannot be your own number', () => {
  assert.equal(
    validateEmergencyContact({ name: 'Mary', phone: '74128860', ownPhone: '74128860' }).ok,
    false,
  );
  assert.equal(
    validateEmergencyContact({ name: 'Mary', phone: '74128861', ownPhone: '74128860' }).ok,
    true,
  );
});

test('phone numbers unlock on confirmation and close 24 hours after the trip', () => {
  const requested = makeBooking({ state: BookingState.REQUESTED });
  assert.equal(contactWindowOpen(requested), false);

  const live = makeBooking({ state: BookingState.IN_PROGRESS, confirmed_at: iso('2026-09-10T00:00:00Z') });
  assert.equal(contactWindowOpen(live, new Date('2026-09-10T00:30:00Z')), true);

  const done = makeBooking({
    state: BookingState.COMPLETED,
    confirmed_at: iso('2026-09-10T00:00:00Z'),
    completed_at: iso('2026-09-10T00:30:00Z'),
  });
  assert.equal(contactWindowOpen(done, new Date('2026-09-11T00:00:00Z')), true);
  assert.equal(contactWindowOpen(done, new Date('2026-09-11T01:00:00Z')), false);
});

// =========================================================================
// SOS
// =========================================================================

const sosFixture = () =>
  buildSosEvent({
    booking: makeBooking({ state: BookingState.IN_PROGRESS, reference: 'WR-4K7P2M' }),
    vehicle: makeVehicle(),
    driverProfile: {
      id: 'p-drv',
      full_name: 'Joe Kaupa',
      phone: '+67574128860',
      emergency_contact_name: 'Rita Kaupa',
      emergency_contact_phone: '+67571110000',
    },
    customerProfile: {
      id: 'p-cust',
      full_name: 'Dennis Warupi',
      phone: '+67572220000',
      emergency_contact_name: 'Anna Warupi',
      emergency_contact_phone: '+67573330000',
    },
    triggeredBy: 'p-cust',
    role: SosRole.CUSTOMER,
    location: { lat: -9.45, lng: 147.19 },
    now: new Date('2026-09-10T13:00:00Z'),
  });

test('an SOS freezes everything known about the booking at that moment', () => {
  const event = sosFixture();
  assert.equal(event.snapshot.reference, 'WR-4K7P2M');
  assert.equal(event.snapshot.vehicle.registration_no, 'BEK-472');
  assert.equal(event.snapshot.driver.phone, '+67574128860');
  assert.equal(event.snapshot.customer.emergency_contact_phone, '+67573330000');
});

test('the emergency SMS carries the vehicle, the driver and a tracking link', () => {
  const sms = emergencyContactSms(sosFixture(), { trackingUrl: 'https://track.wantokride.com/t/abc' });
  assert.match(sms, /WANTOK RIDE ALERT/);
  assert.match(sms, /Dennis Warupi/);
  assert.match(sms, /BEK-472/);
  assert.match(sms, /Joe Kaupa/);
  assert.match(sms, /track\.wantokride\.com/);
});

test('location streams every 10 seconds for an hour', () => {
  const event = sosFixture();
  const plan = streamPlan(event.triggered_at);
  assert.equal(plan.everySeconds, 10);
  assert.equal(isStreaming(event, new Date('2026-09-10T13:59:00Z')), true);
  assert.equal(isStreaming(event, new Date('2026-09-10T14:01:00Z')), false);
});

test('an SOS cannot be acknowledged without a note', () => {
  const event = sosFixture();
  assert.equal(acknowledge(event, { adminId: 'adm-1', note: '  ' }).ok, false);
  const ok = acknowledge(event, { adminId: 'adm-1', note: 'Called passenger, safe' });
  assert.equal(ok.ok, true);
  assert.equal(ok.event.acknowledged_by, 'adm-1');
});

test('a shared tracking link dies two hours after the trip ends', () => {
  const booking = makeBooking({ state: BookingState.COMPLETED, completed_at: iso('2026-09-10T13:00:00Z') });
  assert.equal(isTripShareValid(booking, new Date('2026-09-10T14:59:00Z')), true);
  assert.equal(isTripShareValid(booking, new Date('2026-09-10T15:01:00Z')), false);
});
