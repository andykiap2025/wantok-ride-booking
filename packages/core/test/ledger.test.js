/**
 * Commission ledger tests (spec §8).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BalanceState,
  EntryType,
  buildStatement,
  ceilingState,
  commissionForCompletion,
  freePeriodEnd,
  isInFreePeriod,
  isListable,
  postCompletion,
  postPayment,
  rebuildBalance,
  weekStart,
} from '../src/ledger.js';
import { VehicleStatus } from '../src/constants.js';
import { makeBooking, makeVehicle } from './fixtures.js';

const iso = (s) => new Date(s).toISOString();

// --- The free period -----------------------------------------------------

test('the free period runs 60 days from approval, not from signup', () => {
  const vehicle = makeVehicle({ approved_at: '2026-01-15T00:00:00Z', free_period_ends_at: null });
  assert.equal(freePeriodEnd(vehicle).toISOString(), iso('2026-03-16T00:00:00Z'));
});

test('no commission accrues inside the free period', () => {
  const vehicle = makeVehicle({ free_period_ends_at: '2026-03-16T00:00:00Z' });
  const inside = commissionForCompletion({
    quotedCommission: 350,
    vehicle,
    now: new Date('2026-02-01T00:00:00Z'),
  });
  assert.equal(inside.amount, 0);
  assert.equal(inside.waived, true);
  assert.equal(inside.reason, 'FREE_PERIOD');
});

test('commission starts the moment the free period ends', () => {
  const vehicle = makeVehicle({ free_period_ends_at: '2026-03-16T00:00:00Z' });
  assert.equal(isInFreePeriod(vehicle, new Date('2026-03-15T23:59:59Z')), true);
  assert.equal(isInFreePeriod(vehicle, new Date('2026-03-16T00:00:00Z')), false);

  const after = commissionForCompletion({
    quotedCommission: 350,
    vehicle,
    now: new Date('2026-03-16T00:00:01Z'),
  });
  assert.equal(after.amount, 350);
  assert.equal(after.waived, false);
});

// --- Running balance -----------------------------------------------------

test('the balance is replayed from the entries, in time order', () => {
  const entries = [
    { entry_type: EntryType.COMMISSION, amount: 350, created_at: iso('2026-04-01T10:00:00Z') },
    { entry_type: EntryType.COMMISSION, amount: 500, created_at: iso('2026-04-02T10:00:00Z') },
    { entry_type: EntryType.PAYMENT, amount: 600, created_at: iso('2026-04-03T10:00:00Z') },
  ];
  const { balance, entries: running } = rebuildBalance(entries);
  assert.equal(balance, 250);
  assert.deepEqual(running.map((e) => e.balance_after), [350, 850, 250]);
});

test('a late-syncing entry is replayed in its own place in history', () => {
  // A driver's handset uploads a Tuesday trip on Thursday. The running balance
  // must read as though it had arrived on Tuesday.
  const entries = [
    { entry_type: EntryType.COMMISSION, amount: 500, created_at: iso('2026-04-03T10:00:00Z') },
    { entry_type: EntryType.COMMISSION, amount: 350, created_at: iso('2026-04-01T10:00:00Z') },
  ];
  const { entries: running } = rebuildBalance(entries);
  assert.deepEqual(running.map((e) => e.amount), [350, 500]);
  assert.deepEqual(running.map((e) => e.balance_after), [350, 850]);
});

test('an empty ledger is a zero balance, not NaN', () => {
  assert.equal(rebuildBalance([]).balance, 0);
});

// --- The ceiling ---------------------------------------------------------

test('the owner is warned at 80% of the ceiling', () => {
  assert.equal(ceilingState(7999, 10000).state, BalanceState.OK);
  assert.equal(ceilingState(8000, 10000).state, BalanceState.WARN);
  assert.equal(ceilingState(8000, 10000).shouldWarn, true);
  assert.equal(ceilingState(8000, 10000).shouldSuspend, false);
});

test('the vehicle is suspended above the ceiling, not at it', () => {
  assert.equal(ceilingState(10000, 10000).state, BalanceState.WARN);
  assert.equal(ceilingState(10001, 10000).state, BalanceState.OVER);
  assert.equal(ceilingState(10001, 10000).shouldSuspend, true);
});

test('the ceiling is per vehicle, so admin can raise it for a good owner', () => {
  assert.equal(ceilingState(15000, 20000).state, BalanceState.OK);
  assert.equal(ceilingState(15000, 10000).state, BalanceState.OVER);
});

// --- Posting a completion ------------------------------------------------

test('completing a trip posts commission and reports the side effects', () => {
  const vehicle = makeVehicle({ free_period_ends_at: '2026-03-16T00:00:00Z', commission_ceiling: 10000 });
  const booking = makeBooking({ state: 'COMPLETED', commission_amount: 350 });
  const existing = [
    { entry_type: EntryType.COMMISSION, amount: 7800, created_at: iso('2026-04-01T00:00:00Z') },
  ];

  const result = postCompletion({
    booking,
    vehicle,
    entries: existing,
    now: new Date('2026-04-02T00:00:00Z'),
  });

  assert.equal(result.entry.amount, 350);
  assert.equal(result.balance, 8150);
  assert.equal(result.effects.warnOwner, true);
  assert.equal(result.effects.suspendVehicle, false);
});

test('crossing the ceiling asks for a suspension', () => {
  const vehicle = makeVehicle({ free_period_ends_at: '2026-03-16T00:00:00Z', commission_ceiling: 10000 });
  const booking = makeBooking({ commission_amount: 500 });
  const existing = [
    { entry_type: EntryType.COMMISSION, amount: 9800, created_at: iso('2026-04-01T00:00:00Z') },
  ];
  const result = postCompletion({
    booking,
    vehicle,
    entries: existing,
    now: new Date('2026-04-02T00:00:00Z'),
  });
  assert.equal(result.balance, 10300);
  assert.equal(result.effects.suspendVehicle, true);
});

test('a free-period completion still writes an entry, for K0.00', () => {
  // The trip must appear on the statement even though it cost nothing, or the
  // owner cannot see what the free period was worth to them.
  const vehicle = makeVehicle({ free_period_ends_at: '2026-12-31T00:00:00Z' });
  const result = postCompletion({
    booking: makeBooking({ commission_amount: 350 }),
    vehicle,
    entries: [],
    now: new Date('2026-04-02T00:00:00Z'),
  });
  assert.equal(result.entry.amount, 0);
  assert.equal(result.entry.note, 'Free period — no commission');
  assert.equal(result.balance, 0);
});

// --- Payments ------------------------------------------------------------

test('a verified payment clears the balance and relists the vehicle', () => {
  const vehicle = makeVehicle({ status: VehicleStatus.SUSPENDED_UNPAID, commission_ceiling: 10000 });
  const entries = [
    { entry_type: EntryType.COMMISSION, amount: 10300, created_at: iso('2026-04-01T00:00:00Z') },
  ];
  const result = postPayment({
    payment: { amount: 10300, method: 'BANK_TRANSFER', reference: 'BSP-99812' },
    vehicle,
    entries,
    now: new Date('2026-04-05T00:00:00Z'),
  });
  assert.equal(result.balance, 0);
  assert.equal(result.effects.relistVehicle, true);
});

test('a part payment that still leaves the balance over the ceiling does not relist', () => {
  const vehicle = makeVehicle({ status: VehicleStatus.SUSPENDED_UNPAID, commission_ceiling: 10000 });
  const entries = [
    { entry_type: EntryType.COMMISSION, amount: 15000, created_at: iso('2026-04-01T00:00:00Z') },
  ];
  const result = postPayment({
    payment: { amount: 3000, method: 'MOBILE_MONEY' },
    vehicle,
    entries,
    now: new Date('2026-04-05T00:00:00Z'),
  });
  assert.equal(result.balance, 12000);
  assert.equal(result.effects.relistVehicle, false);
});

test('paying does not relist a vehicle suspended for expired documents', () => {
  // Money and roadworthiness are separate problems. An owner cannot buy his
  // way past an expired insurance certificate.
  const vehicle = makeVehicle({ status: VehicleStatus.SUSPENDED_DOCS, commission_ceiling: 10000 });
  const result = postPayment({
    payment: { amount: 5000, method: 'BANK_TRANSFER' },
    vehicle,
    entries: [{ entry_type: EntryType.COMMISSION, amount: 5000, created_at: iso('2026-04-01T00:00:00Z') }],
    now: new Date('2026-04-05T00:00:00Z'),
  });
  assert.equal(result.balance, 0);
  assert.equal(result.effects.relistVehicle, false);
});

// --- Listability ---------------------------------------------------------

test('only an approved, unsuspended vehicle appears in customer search', () => {
  assert.equal(isListable(makeVehicle({ status: VehicleStatus.APPROVED })), true);
  for (const status of [
    VehicleStatus.SUSPENDED_UNPAID,
    VehicleStatus.SUSPENDED_DOCS,
    VehicleStatus.SUSPENDED_ADMIN,
    VehicleStatus.PENDING_INSPECTION,
    VehicleStatus.RETIRED,
    VehicleStatus.REJECTED,
  ]) {
    assert.equal(isListable(makeVehicle({ status })), false, status);
  }
});

// --- Statements ----------------------------------------------------------

test('the Monday statement opens on last week’s closing balance', () => {
  const entries = [
    { entry_type: EntryType.COMMISSION, amount: 1000, created_at: iso('2026-04-01T00:00:00Z'), gross_fare: 10000 },
    { entry_type: EntryType.COMMISSION, amount: 350, created_at: iso('2026-04-07T10:00:00Z'), gross_fare: 3500 },
    { entry_type: EntryType.COMMISSION, amount: 450, created_at: iso('2026-04-09T10:00:00Z'), gross_fare: 4500 },
    { entry_type: EntryType.PAYMENT, amount: 500, created_at: iso('2026-04-10T10:00:00Z') },
  ];
  const statement = buildStatement({
    entries,
    from: '2026-04-06T00:00:00Z',
    to: '2026-04-13T00:00:00Z',
    vehicle: makeVehicle(),
  });

  assert.equal(statement.openingBalance, 1000);
  assert.equal(statement.trips, 2);
  assert.equal(statement.grossFares, 8000);
  assert.equal(statement.commissionCharged, 800);
  assert.equal(statement.paymentsReceived, 500);
  assert.equal(statement.closingBalance, 1300);
});

test('a quiet week carries the balance forward unchanged', () => {
  const entries = [
    { entry_type: EntryType.COMMISSION, amount: 2500, created_at: iso('2026-04-01T00:00:00Z') },
  ];
  const statement = buildStatement({
    entries,
    from: '2026-04-06T00:00:00Z',
    to: '2026-04-13T00:00:00Z',
    vehicle: makeVehicle(),
  });
  assert.equal(statement.openingBalance, 2500);
  assert.equal(statement.closingBalance, 2500);
  assert.equal(statement.trips, 0);
});

test('the statement week starts on Monday', () => {
  assert.equal(weekStart(new Date('2026-04-09T15:00:00Z')).toISOString(), iso('2026-04-06T00:00:00Z'));
  assert.equal(weekStart(new Date('2026-04-06T00:00:00Z')).toISOString(), iso('2026-04-06T00:00:00Z'));
  // Sunday belongs to the week that started the Monday before it.
  assert.equal(weekStart(new Date('2026-04-12T23:00:00Z')).toISOString(), iso('2026-04-06T00:00:00Z'));
});
