/**
 * Fare engine tests (spec §19, phase 3: "unit tests covering night boundaries,
 * minimum fares and rounding").
 *
 * Every expected number here is worked by hand from the spec's own example
 * rate table, so a failure can be checked against the document rather than
 * against another piece of code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { quote, quoteAllClasses, quoteWithFreshTable, StaleRateTableError } from '../src/fare.js';
import { isNightAt, isRateTableFresh, resolveRateVersion, normaliseRateVersion } from '../src/rates.js';
import { roundUpToea, toToea, formatKina, percentOf } from '../src/money.js';
import { BUS_RATE, SEDAN_RATE, pngTime } from './fixtures.js';

// --- Money ---------------------------------------------------------------

test('kina converts to whole toea without float drift', () => {
  assert.equal(toToea(3.5), 350);
  assert.equal(toToea(10), 1000);
  assert.equal(toToea(0.1), 10);
  assert.equal(toToea('25.50'), 2550);
  // The classic: 3.50 * 100 is 350.00000000000006 in binary floating point.
  assert.equal(toToea(1.15), 115);
});

test('fares round up to the nearest K5, never down', () => {
  assert.equal(roundUpToea(2000, 5), 2000); // exact multiple stays put
  assert.equal(roundUpToea(2001, 5), 2500); // one toea over pushes a whole step
  assert.equal(roundUpToea(2499, 5), 2500);
  assert.equal(roundUpToea(2501, 5), 3000);
  assert.equal(roundUpToea(3100, 5), 3500);
});

test('a rounding step of zero disables rounding', () => {
  assert.equal(roundUpToea(3137, 0), 3137);
});

test('kina formats the way it is written on a receipt', () => {
  assert.equal(formatKina(3500), 'K35.00');
  assert.equal(formatKina(350), 'K3.50');
  assert.equal(formatKina(-1250), '-K12.50');
});

// --- The worked example --------------------------------------------------

test('the spec worked example: 6 km, daytime, sedan', () => {
  // base K10.00 + (K3.50 x 6) = K31.00, over the K20 minimum, day rate,
  // rounded up to the nearest K5 = K35.00. Commission 10% = K3.50.
  const q = quote({ rate: SEDAN_RATE, distanceKm: 6, startAt: pngTime(2026, 9, 10, 12) });
  assert.equal(q.baseFare, 1000);
  assert.equal(q.distanceCharge, 2100);
  assert.equal(q.metered, 3100);
  assert.equal(q.isNight, false);
  assert.equal(q.roundingUplift, 400);
  assert.equal(q.fare, 3500);
  assert.equal(q.commission, 350);
  assert.equal(q.driverNet, 3150);
  assert.equal(q.total, 3500);
});

// --- Minimum fare --------------------------------------------------------

test('a short trip is floored to the minimum fare', () => {
  // 1 km: K10.00 + K3.50 = K13.50, under the K20 minimum.
  const q = quote({ rate: SEDAN_RATE, distanceKm: 1, startAt: pngTime(2026, 9, 10, 12) });
  assert.equal(q.metered, 1350);
  assert.equal(q.flooredToMinimum, true);
  assert.equal(q.fare, 2000); // K20 is already a clean multiple of K5
});

test('the minimum is applied before the night multiplier, not after', () => {
  // This ordering is set by spec §5 and it is worth K10 a trip.
  // Floor first:  K20.00 x 1.30 = K26.00 -> rounds to K30.00
  // Multiply first: K13.50 x 1.30 = K17.55 -> floored to K20.00
  const q = quote({ rate: SEDAN_RATE, distanceKm: 1, startAt: pngTime(2026, 9, 10, 21) });
  assert.equal(q.flooredToMinimum, true);
  assert.equal(q.isNight, true);
  assert.equal(q.fare, 3000);
});

test('a fare exactly on the minimum is not treated as floored', () => {
  // K20.00 metered needs (20 - 10) / 3.5 km.
  const q = quote({ rate: SEDAN_RATE, distanceKm: 10 / 3.5, startAt: pngTime(2026, 9, 10, 12) });
  assert.equal(q.metered, 2000);
  assert.equal(q.flooredToMinimum, false);
});

// --- Night boundaries ----------------------------------------------------

test('the night window opens inclusively at 20:00', () => {
  assert.equal(isNightAt(pngTime(2026, 9, 10, 19, 59), '20:00', '05:00'), false);
  assert.equal(isNightAt(pngTime(2026, 9, 10, 20, 0), '20:00', '05:00'), true);
  assert.equal(isNightAt(pngTime(2026, 9, 10, 20, 1), '20:00', '05:00'), true);
});

test('the night window closes exclusively at 05:00', () => {
  assert.equal(isNightAt(pngTime(2026, 9, 11, 4, 59), '20:00', '05:00'), true);
  assert.equal(isNightAt(pngTime(2026, 9, 11, 5, 0), '20:00', '05:00'), false);
  assert.equal(isNightAt(pngTime(2026, 9, 11, 5, 1), '20:00', '05:00'), false);
});

test('the night window wraps midnight', () => {
  assert.equal(isNightAt(pngTime(2026, 9, 10, 23, 59), '20:00', '05:00'), true);
  assert.equal(isNightAt(pngTime(2026, 9, 11, 0, 0), '20:00', '05:00'), true);
  assert.equal(isNightAt(pngTime(2026, 9, 11, 2, 30), '20:00', '05:00'), true);
});

test('the night window is evaluated in Port Moresby time, not the handset time', () => {
  // 10:00Z is 20:00 in Moresby. A phone left on UTC would call this a day fare
  // and quote the passenger K10 less than the driver expects.
  const instant = new Date('2026-09-10T10:00:00Z');
  assert.equal(isNightAt(instant, '20:00', '05:00'), true);
});

test('night applies the multiplier to the whole fare', () => {
  // 6 km: K31.00 metered, x1.30 = K40.30, rounded up = K45.00.
  const q = quote({ rate: SEDAN_RATE, distanceKm: 6, startAt: pngTime(2026, 9, 10, 21) });
  assert.equal(q.isNight, true);
  assert.equal(q.nightMultiplier, 1.3);
  assert.equal(q.nightUplift, 930);
  assert.equal(q.fare, 4500);
  assert.equal(q.commission, 450);
});

test('day and night on either side of the boundary differ by the multiplier', () => {
  const day = quote({ rate: SEDAN_RATE, distanceKm: 6, startAt: pngTime(2026, 9, 10, 19, 59) });
  const night = quote({ rate: SEDAN_RATE, distanceKm: 6, startAt: pngTime(2026, 9, 10, 20, 0) });
  assert.equal(day.fare, 3500);
  assert.equal(night.fare, 4500);
});

test('a zero-length night window never charges a night rate', () => {
  const noNight = { ...SEDAN_RATE, nightStart: '00:00', nightEnd: '00:00' };
  assert.equal(quote({ rate: noNight, distanceKm: 6, startAt: pngTime(2026, 9, 10, 2) }).isNight, false);
});

// --- Day/night is decided by the trip start, not the booking -------------

test('a trip scheduled into the night is a night fare even when booked at noon', () => {
  // Spec §5, rule 2. `quote` only ever sees the start time, which is how this
  // is enforced: there is no way to pass it the booking time by accident.
  const bookedAtNoon = pngTime(2026, 9, 10, 12);
  const startsAt9pm = pngTime(2026, 9, 10, 21);
  const q = quote({ rate: SEDAN_RATE, distanceKm: 6, startAt: startsAt9pm });
  assert.equal(q.isNight, true);
  assert.notEqual(bookedAtNoon.getTime(), startsAt9pm.getTime());
});

// --- Commission ----------------------------------------------------------

test('commission is charged on the locked fare, not the metered fare', () => {
  // Rounding pushed K31.00 to K35.00. Commission follows the K35.
  const q = quote({ rate: SEDAN_RATE, distanceKm: 6, startAt: pngTime(2026, 9, 10, 12) });
  assert.equal(q.commission, percentOf(q.fare, 10));
  assert.notEqual(q.commission, percentOf(q.metered, 10));
});

test('commission percentage is per class, so it can be tuned', () => {
  const cheapBus = { ...BUS_RATE, commissionPct: 7.5 };
  const q = quote({ rate: cheapBus, distanceKm: 10, startAt: pngTime(2026, 9, 10, 12) });
  assert.equal(q.commissionPct, 7.5);
  assert.equal(q.commission, percentOf(q.fare, 7.5));
});

test('the service fee is a separate line and is not commissioned', () => {
  const withFee = { ...SEDAN_RATE, serviceFee: 200 };
  const q = quote({ rate: withFee, distanceKm: 6, startAt: pngTime(2026, 9, 10, 12) });
  assert.equal(q.fare, 3500);
  assert.equal(q.serviceFee, 200);
  assert.equal(q.total, 3700);
  assert.equal(q.commission, 350); // 10% of K35, not of K37
});

// --- Rate versioning -----------------------------------------------------

test('the rate in force is the newest one that has already taken effect', () => {
  const versions = [
    { ...SEDAN_RATE, id: 'v1', effectiveFrom: new Date('2026-01-01T00:00:00Z') },
    { ...SEDAN_RATE, id: 'v2', effectiveFrom: new Date('2026-06-01T00:00:00Z') },
    { ...SEDAN_RATE, id: 'v3-staged', effectiveFrom: new Date('2027-01-01T00:00:00Z') },
  ];
  const at = new Date('2026-09-10T00:00:00Z');
  assert.equal(resolveRateVersion(versions, 'SEDAN', at).id, 'v2');
});

test('a rate version dated into the future is staged, not live', () => {
  const versions = [{ ...SEDAN_RATE, id: 'future', effectiveFrom: new Date('2030-01-01T00:00:00Z') }];
  assert.equal(resolveRateVersion(versions, 'SEDAN', new Date('2026-09-10T00:00:00Z')), null);
});

test('rate versions are resolved per class', () => {
  const versions = [SEDAN_RATE, BUS_RATE];
  const at = new Date('2026-09-10T00:00:00Z');
  assert.equal(resolveRateVersion(versions, 'BUS10', at).id, 'rate-bus-v1');
  assert.equal(resolveRateVersion(versions, 'WAGON4WD', at), null);
});

test('a DB row with kina decimals normalises to whole toea', () => {
  const row = normaliseRateVersion({
    id: 'r',
    class_code: 'UTE',
    base_fare: '12.50',
    per_km: '4.25',
    minimum_fare: '25.00',
    night_multiplier: '1.30',
    night_start: '20:00',
    night_end: '05:00',
    rounding: '5',
    service_fee: '0.00',
    commission_pct: '10.00',
    effective_from: '2026-01-01T00:00:00Z',
  });
  assert.equal(row.baseFare, 1250);
  assert.equal(row.perKm, 425);
  assert.equal(row.minimumFare, 2500);
  assert.equal(row.nightMultiplier, 1.3);
});

// --- Staleness guard -----------------------------------------------------

test('a rate table under 24 hours old is fresh', () => {
  const now = new Date('2026-09-10T12:00:00Z');
  assert.equal(isRateTableFresh(new Date('2026-09-10T00:00:00Z'), now), true);
  assert.equal(isRateTableFresh(new Date('2026-09-09T12:00:01Z'), now), true);
});

test('a rate table 24 hours old or older refuses to quote', () => {
  const now = new Date('2026-09-10T12:00:00Z');
  assert.equal(isRateTableFresh(new Date('2026-09-09T12:00:00Z'), now), false);
  assert.equal(isRateTableFresh(null, now), false);

  assert.throws(
    () =>
      quoteWithFreshTable({
        rate: SEDAN_RATE,
        distanceKm: 6,
        startAt: now,
        fetchedAt: new Date('2026-09-08T12:00:00Z'),
        now,
      }),
    StaleRateTableError,
  );
});

// --- The list ------------------------------------------------------------

test('one distance prices every class at once', () => {
  const quotes = quoteAllClasses({
    rates: [SEDAN_RATE, BUS_RATE],
    distanceKm: 6,
    startAt: pngTime(2026, 9, 10, 12),
  });
  assert.equal(quotes.SEDAN.fare, 3500);
  // Bus: K25.00 + (K6.00 x 6) = K61.00, over the K60 minimum, rounds to K65.00.
  assert.equal(quotes.BUS10.fare, 6500);
});

// --- Guards --------------------------------------------------------------

test('a negative or non-numeric distance is refused rather than priced', () => {
  assert.throws(() => quote({ rate: SEDAN_RATE, distanceKm: -1 }), TypeError);
  assert.throws(() => quote({ rate: SEDAN_RATE, distanceKm: NaN }), TypeError);
  assert.throws(() => quote({ rate: null, distanceKm: 5 }), TypeError);
});

test('a zero-distance trip still charges the minimum', () => {
  const q = quote({ rate: SEDAN_RATE, distanceKm: 0, startAt: pngTime(2026, 9, 10, 12) });
  assert.equal(q.fare, 2000);
});
