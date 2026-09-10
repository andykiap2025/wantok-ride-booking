/**
 * Booking state machine tests (spec §7).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BookingEvent as E,
  IllegalTransitionError,
  acceptDeadline,
  applyEvent,
  canApply,
  cancellationPolicy,
  eventsFrom,
  isCommissionable,
  makeReference,
  secondsToAccept,
} from '../src/booking.js';
import { BookingState as S, Timing } from '../src/constants.js';
import { makeBooking, NOON, pngTime } from './fixtures.js';

const at = (mins) => new Date(NOON.getTime() + mins * 60_000);
const secs = (s) => new Date(NOON.getTime() + s * 1000);

// --- The happy path ------------------------------------------------------

test('a booking walks DRAFT to COMPLETED', () => {
  let b = makeBooking({ created_at: NOON.toISOString() });

  b = applyEvent(b, E.REQUEST, { actor: 'customer', now: NOON });
  assert.equal(b.state, S.REQUESTED);
  assert.equal(b.requested_at, NOON.toISOString());

  b = applyEvent(b, E.ACCEPT, { actor: 'driver', now: secs(30) });
  assert.equal(b.state, S.CONFIRMED);

  b = applyEvent(b, E.START_EN_ROUTE, { actor: 'driver', now: at(1) });
  assert.equal(b.state, S.DRIVER_EN_ROUTE);

  b = applyEvent(b, E.ARRIVE, { actor: 'driver', now: at(6) });
  assert.equal(b.state, S.ARRIVED);

  b = applyEvent(b, E.START_TRIP, { actor: 'driver', now: at(8) });
  assert.equal(b.state, S.IN_PROGRESS);

  b = applyEvent(b, E.COMPLETE, { actor: 'driver', now: at(28) });
  assert.equal(b.state, S.COMPLETED);
  assert.equal(b.completed_at, at(28).toISOString());
  assert.equal(isCommissionable(b.state), true);
});

test('applying an event never mutates the booking it was given', () => {
  // The offline queue replays these. A mutated row would corrupt the local
  // mirror the moment a sync failed halfway.
  const before = makeBooking();
  const frozen = JSON.stringify(before);
  applyEvent(before, E.REQUEST, { actor: 'customer', now: NOON });
  assert.equal(JSON.stringify(before), frozen);
});

test('the timestamp recorded is the one passed in, not the wall clock', () => {
  // A driver taps "arrived" in a dead spot at 14:05 and syncs at 14:40. The
  // record has to say 14:05 (spec §14).
  const happened = pngTime(2026, 9, 10, 14, 5);
  let b = makeBooking({ state: S.DRIVER_EN_ROUTE });
  b = applyEvent(b, E.ARRIVE, { actor: 'driver', now: happened });
  assert.equal(b.arrived_at, happened.toISOString());
});

// --- Illegal transitions -------------------------------------------------

test('a booking cannot skip states', () => {
  const b = makeBooking({ state: S.CONFIRMED });
  assert.throws(() => applyEvent(b, E.COMPLETE, { actor: 'driver' }), IllegalTransitionError);
  assert.throws(() => applyEvent(b, E.START_TRIP, { actor: 'driver' }), IllegalTransitionError);
});

test('terminal states accept nothing but a dispute', () => {
  for (const state of [S.DECLINED, S.EXPIRED]) {
    assert.deepEqual(eventsFrom(state), []);
  }
  const completed = makeBooking({ state: S.COMPLETED });
  assert.deepEqual(eventsFrom(completed.state), [E.RAISE_DISPUTE]);
});

test('the actor is checked, not just the state', () => {
  const b = makeBooking({ state: S.REQUESTED, requested_at: NOON.toISOString() });
  // A customer cannot accept his own booking on the driver's behalf.
  assert.equal(canApply(b, E.ACCEPT, { actor: 'customer', now: NOON }).ok, false);
  assert.equal(canApply(b, E.ACCEPT, { actor: 'driver', now: NOON }).ok, true);
});

test('a driver cannot cancel as the customer', () => {
  const b = makeBooking({ state: S.CONFIRMED, confirmed_at: NOON.toISOString() });
  const verdict = canApply(b, E.CANCEL_CUSTOMER, { actor: 'driver', payload: { reason: 'X' } });
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /customer/);
});

// --- The 90-second countdown --------------------------------------------

test('an immediate booking gives the driver 90 seconds', () => {
  const b = makeBooking({ state: S.REQUESTED, requested_at: NOON.toISOString() });
  assert.equal(secondsToAccept(b, NOON), Timing.ACCEPT_WINDOW_SECONDS);
  assert.equal(secondsToAccept(b, secs(60)), 30);
  assert.equal(secondsToAccept(b, secs(200)), 0); // floored, never negative
  assert.equal(acceptDeadline(b).getTime(), NOON.getTime() + 90_000);
});

test('a scheduled booking gives the driver 30 minutes', () => {
  const b = makeBooking({
    state: S.REQUESTED,
    is_scheduled: true,
    scheduled_for: at(600).toISOString(),
    requested_at: NOON.toISOString(),
  });
  assert.equal(acceptDeadline(b).getTime(), NOON.getTime() + 30 * 60_000);
});

test('accepting after the countdown has run out is refused', () => {
  const b = makeBooking({ state: S.REQUESTED, requested_at: NOON.toISOString() });
  assert.equal(canApply(b, E.ACCEPT, { actor: 'driver', now: secs(89) }).ok, true);
  assert.equal(canApply(b, E.ACCEPT, { actor: 'driver', now: secs(91) }).ok, false);
});

test('expiry cannot be fired before the window closes', () => {
  const b = makeBooking({ state: S.REQUESTED, requested_at: NOON.toISOString() });
  assert.equal(canApply(b, E.EXPIRE, { now: secs(45) }).ok, false);
  assert.equal(canApply(b, E.EXPIRE, { now: secs(95) }).ok, true);
});

// --- Declines ------------------------------------------------------------

test('a decline requires a reason', () => {
  const b = makeBooking({ state: S.REQUESTED, requested_at: NOON.toISOString() });
  assert.equal(canApply(b, E.DECLINE, { actor: 'driver', payload: {} }).ok, false);
  assert.equal(
    canApply(b, E.DECLINE, { actor: 'driver', payload: { reason: 'TOO_FAR' } }).ok,
    true,
  );
});

test('choosing Other on a decline requires the free text', () => {
  const b = makeBooking({ state: S.REQUESTED, requested_at: NOON.toISOString() });
  assert.equal(canApply(b, E.DECLINE, { actor: 'driver', payload: { reason: 'OTHER' } }).ok, false);
  assert.equal(
    canApply(b, E.DECLINE, { actor: 'driver', payload: { reason: 'OTHER', note: 'Fuel is out' } }).ok,
    true,
  );
});

test('a decline is terminal for that vehicle — it is never reassigned', () => {
  let b = makeBooking({ state: S.REQUESTED, requested_at: NOON.toISOString() });
  b = applyEvent(b, E.DECLINE, {
    actor: 'driver',
    payload: { reason: 'AREA_TIME' },
    now: secs(20),
  });
  assert.equal(b.state, S.DECLINED);
  assert.equal(b.decline_reason, 'AREA_TIME');
  assert.deepEqual(eventsFrom(b.state), []);
});

// --- Cancellations -------------------------------------------------------

test('cancelling before anyone accepted is free and unlogged', () => {
  const policy = cancellationPolicy(S.REQUESTED, E.CANCEL_CUSTOMER);
  assert.equal(policy.logged, false);
  assert.equal(policy.weight, 0);
});

test('cancelling after confirmation is logged against the customer', () => {
  const policy = cancellationPolicy(S.CONFIRMED, E.CANCEL_CUSTOMER);
  assert.equal(policy.logged, true);
  assert.equal(policy.weight, 1);
  assert.equal(policy.against, 'CUSTOMER');
});

test('cancelling once the driver is en route counts double', () => {
  assert.equal(cancellationPolicy(S.DRIVER_EN_ROUTE, E.CANCEL_CUSTOMER).weight, 2);
  assert.equal(cancellationPolicy(S.ARRIVED, E.CANCEL_CUSTOMER).weight, 2);
});

test('a driver cancelling after accepting is logged against the vehicle', () => {
  const policy = cancellationPolicy(S.CONFIRMED, E.CANCEL_DRIVER);
  assert.equal(policy.against, 'VEHICLE');
  assert.equal(policy.weight, 1);
});

test('declining is logged for reporting but is not a strike', () => {
  // Penalising declines just teaches drivers to accept and then go quiet,
  // which leaves the passenger worse off.
  const policy = cancellationPolicy(S.REQUESTED, E.DECLINE);
  assert.equal(policy.logged, true);
  assert.equal(policy.weight, 0);
});

test('commission is never charged on a cancellation or a no-show', () => {
  for (const state of [
    S.CANCELLED_BY_CUSTOMER,
    S.CANCELLED_BY_DRIVER,
    S.NO_SHOW_CUSTOMER,
    S.NO_SHOW_DRIVER,
    S.DECLINED,
    S.EXPIRED,
  ]) {
    assert.equal(isCommissionable(state), false);
  }
});

// --- No-shows ------------------------------------------------------------

test('the driver must wait 10 minutes before marking a customer no-show', () => {
  const b = makeBooking({ state: S.ARRIVED, arrived_at: NOON.toISOString() });
  assert.equal(canApply(b, E.MARK_NO_SHOW_CUSTOMER, { actor: 'driver', now: at(9) }).ok, false);
  assert.equal(canApply(b, E.MARK_NO_SHOW_CUSTOMER, { actor: 'driver', now: at(10) }).ok, true);
});

test('the customer can report a driver no-show 15 minutes after the agreed time', () => {
  const b = makeBooking({ state: S.CONFIRMED, confirmed_at: NOON.toISOString() });
  assert.equal(canApply(b, E.MARK_NO_SHOW_DRIVER, { actor: 'customer', now: at(14) }).ok, false);
  assert.equal(canApply(b, E.MARK_NO_SHOW_DRIVER, { actor: 'customer', now: at(15) }).ok, true);
});

test('for a scheduled booking the grace runs from the booked time, not the confirmation', () => {
  // Confirmed on Monday for a Friday 07:00 pickup. Marking a no-show on
  // Monday afternoon would otherwise be legal.
  const pickup = pngTime(2026, 9, 14, 7, 0);
  const b = makeBooking({
    state: S.CONFIRMED,
    is_scheduled: true,
    scheduled_for: pickup.toISOString(),
    confirmed_at: NOON.toISOString(),
  });
  assert.equal(canApply(b, E.MARK_NO_SHOW_DRIVER, { actor: 'customer', now: at(60) }).ok, false);
  assert.equal(
    canApply(b, E.MARK_NO_SHOW_DRIVER, {
      actor: 'customer',
      now: new Date(pickup.getTime() + 16 * 60_000),
    }).ok,
    true,
  );
});

// --- Disputes ------------------------------------------------------------

test('either side can dispute, and it remembers the state it came from', () => {
  let b = makeBooking({ state: S.COMPLETED, completed_at: NOON.toISOString() });
  b = applyEvent(b, E.RAISE_DISPUTE, { actor: 'customer', payload: { category: 'FARE' }, now: at(30) });
  assert.equal(b.state, S.DISPUTED);
  assert.equal(b.state_before_dispute, S.COMPLETED);
  assert.equal(b.dispute_category, 'FARE');
});

test('a dispute requires a category', () => {
  const b = makeBooking({ state: S.COMPLETED });
  assert.equal(canApply(b, E.RAISE_DISPUTE, { actor: 'customer', payload: {} }).ok, false);
});

// --- References ----------------------------------------------------------

test('booking references avoid characters that sound alike on a bad line', () => {
  // No I, L, O, S, U, 0, 1 or 5 — these are read aloud down a phone.
  let seq = 0;
  const ref = makeReference(() => {
    seq += 0.037;
    return seq % 1;
  });
  assert.match(ref, /^WR-[234679ABCDEFGHJKMNPQRTVWXYZ]{6}$/);
  assert.doesNotMatch(ref, /[ILOSU015]/);
});
