/**
 * The commission ledger (spec §8).
 *
 * Wantok Ride never touches the passenger's money. The fare is cash, hand to
 * hand. What the platform holds is a *claim* — 10% of every completed trip —
 * and this file is the entire accounting of that claim.
 *
 * The rule that keeps it honest: `vehicles.balance_owed` is **derived from the
 * entries, never edited**. If a balance is ever wrong, it is wrong because an
 * entry is wrong, and the entry can be found and shown to the owner. An admin
 * who wants to change a balance writes an ADJUSTMENT that says who and why.
 */

import { Thresholds, Timing, VehicleStatus } from './constants.js';
import { percentOf, sumToea } from './money.js';

export const EntryType = {
  /** 10% of a completed trip's locked fare. Increases what is owed. */
  COMMISSION: 'COMMISSION',
  /** An owner's bank transfer or mobile money, verified by admin. Reduces it. */
  PAYMENT: 'PAYMENT',
  /** An admin correction. Signed, and it must carry a note. */
  ADJUSTMENT: 'ADJUSTMENT',
  /** Debt admin has decided not to pursue. Reduces it, and is reported. */
  WRITE_OFF: 'WRITE_OFF',
};

/** Which way an entry moves the balance owed. */
export function signOf(entryType) {
  return entryType === EntryType.COMMISSION ? 1 : -1;
}

export const BalanceState = { OK: 'OK', WARN: 'WARN', OVER: 'OVER' };

/**
 * Is this vehicle still inside its 60-day free period? (spec §2)
 *
 * The free period runs from **approval**, not from signup — an owner who waits
 * three weeks for an inspection slot does not lose three weeks of it.
 */
export function isInFreePeriod(vehicle, now = new Date()) {
  const endsAt = freePeriodEnd(vehicle);
  return endsAt ? now.getTime() < endsAt.getTime() : false;
}

export function freePeriodEnd(vehicle) {
  const explicit = vehicle.free_period_ends_at ?? vehicle.freePeriodEndsAt;
  if (explicit) return new Date(explicit);
  const approved = vehicle.approved_at ?? vehicle.approvedAt;
  if (!approved) return null;
  return new Date(new Date(approved).getTime() + Timing.FREE_PERIOD_DAYS * 86_400_000);
}

/**
 * The commission a completed trip actually accrues.
 *
 * The quote already carries a commission figure, calculated at booking from
 * the class's rate. This applies the free period on top, and returns both the
 * charge and the reason — so a driver looking at a K0.00 commission line can
 * see it says "free period" rather than wondering if it is a bug.
 */
export function commissionForCompletion({ quotedCommission, vehicle, now = new Date() }) {
  if (isInFreePeriod(vehicle, now)) {
    return { amount: 0, waived: true, reason: 'FREE_PERIOD', freePeriodEndsAt: freePeriodEnd(vehicle) };
  }
  return { amount: quotedCommission, waived: false, reason: null };
}

/** Recompute commission from a fare, for admin corrections and back-testing. */
export function commissionOn(fareToea, commissionPct) {
  return percentOf(fareToea, commissionPct);
}

/**
 * Replay the entries and hand back the running balance at each one.
 *
 * This is the only function allowed to produce a balance. Entries are sorted
 * by time so a late-syncing driver handset cannot reorder history.
 */
export function rebuildBalance(entries) {
  const ordered = [...entries].sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at),
  );
  let balance = 0;
  const withRunning = ordered.map((entry) => {
    balance += signOf(entry.entry_type) * entry.amount;
    return { ...entry, balance_after: balance };
  });
  return { balance, entries: withRunning };
}

/**
 * Where this vehicle sits against its ceiling (spec §8, steps 2–3).
 *
 * WARN at 80% is a courtesy that costs the platform nothing and saves an owner
 * being surprised into suspension mid-shift.
 */
export function ceilingState(balance, ceiling = Thresholds.DEFAULT_CEILING_TOEA) {
  const fraction = ceiling > 0 ? balance / ceiling : 0;
  let state = BalanceState.OK;
  if (balance > ceiling) state = BalanceState.OVER;
  else if (fraction >= Thresholds.BALANCE_WARN_FRACTION) state = BalanceState.WARN;
  return {
    state,
    balance,
    ceiling,
    fraction,
    remaining: Math.max(0, ceiling - balance),
    shouldWarn: state === BalanceState.WARN,
    shouldSuspend: state === BalanceState.OVER,
  };
}

/**
 * Post a completed trip's commission and say what should happen next.
 *
 * Returns the entry to write plus the side effects — suspend the vehicle, warn
 * the owner — rather than performing them, so the same logic runs on the
 * server, in a test, and in the mock backend the apps develop against.
 */
export function postCompletion({ booking, vehicle, entries, now = new Date() }) {
  const { amount, waived, reason } = commissionForCompletion({
    quotedCommission: booking.commission_amount,
    vehicle,
    now,
  });

  const entry = {
    vehicle_id: vehicle.id,
    booking_id: booking.id,
    entry_type: EntryType.COMMISSION,
    amount,
    note: waived ? 'Free period — no commission' : null,
    created_at: now.toISOString(),
  };

  const { balance } = rebuildBalance([...entries, entry]);
  const ceiling = ceilingState(balance, vehicle.commission_ceiling);

  return {
    entry,
    balance,
    ceiling,
    waived,
    reason,
    effects: {
      warnOwner: ceiling.shouldWarn,
      suspendVehicle: ceiling.shouldSuspend && vehicle.status === VehicleStatus.APPROVED,
    },
  };
}

/**
 * Post an owner payment once admin has matched it to the bank statement.
 *
 * Relisting is automatic (spec §8, step 5). An owner who has paid should not
 * have to ring anyone to get back on the map.
 */
export function postPayment({ payment, vehicle, entries, now = new Date() }) {
  const entry = {
    vehicle_id: vehicle.id,
    booking_id: null,
    entry_type: EntryType.PAYMENT,
    amount: payment.amount,
    note: `${payment.method} ${payment.reference ?? ''}`.trim(),
    created_at: now.toISOString(),
  };

  const { balance } = rebuildBalance([...entries, entry]);
  const ceiling = ceilingState(balance, vehicle.commission_ceiling);

  return {
    entry,
    balance,
    ceiling,
    effects: {
      // Only an unpaid suspension clears here. A vehicle parked up for expired
      // insurance stays parked up no matter how much its owner pays.
      relistVehicle:
        vehicle.status === VehicleStatus.SUSPENDED_UNPAID && !ceiling.shouldSuspend,
    },
  };
}

/**
 * Confirmed bookings survive a suspension (spec §8, step 3).
 *
 * The vehicle disappears from search, but a passenger who booked ten minutes
 * ago still gets their ride. Stranding a paying passenger to enforce a K100
 * debt is a bad trade for everyone.
 */
export function isListable(vehicle, now = new Date()) {
  return vehicle.status === VehicleStatus.APPROVED && !isSuspended(vehicle, now);
}

export function isSuspended(vehicle) {
  return [
    VehicleStatus.SUSPENDED_UNPAID,
    VehicleStatus.SUSPENDED_DOCS,
    VehicleStatus.SUSPENDED_ADMIN,
  ].includes(vehicle.status);
}

/**
 * The Monday statement (spec §8).
 *
 * "The owner should never need to ask what they owe." Opening balance, the
 * week's trips, what was paid, closing balance — the shape of a bank statement,
 * because that is the shape owners already know how to read.
 */
export function buildStatement({ entries, from, to, vehicle }) {
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  const { entries: running } = rebuildBalance(entries);

  const before = running.filter((e) => new Date(e.created_at).getTime() < start);
  const window = running.filter((e) => {
    const t = new Date(e.created_at).getTime();
    return t >= start && t < end;
  });

  const opening = before.length ? before[before.length - 1].balance_after : 0;
  const closing = window.length ? window[window.length - 1].balance_after : opening;

  const commissions = window.filter((e) => e.entry_type === EntryType.COMMISSION);
  const payments = window.filter((e) => e.entry_type === EntryType.PAYMENT);
  const adjustments = window.filter(
    (e) => e.entry_type === EntryType.ADJUSTMENT || e.entry_type === EntryType.WRITE_OFF,
  );

  return {
    vehicleId: vehicle?.id ?? null,
    registration: vehicle?.registration_no ?? null,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    openingBalance: opening,
    trips: commissions.length,
    // Gross fares are reconstructed from commission at the rate that was
    // actually charged, so a class whose rate changed mid-week still adds up.
    grossFares: sumToea(commissions.map((e) => e.gross_fare ?? 0)),
    commissionCharged: sumToea(commissions.map((e) => e.amount)),
    paymentsReceived: sumToea(payments.map((e) => e.amount)),
    adjustments: sumToea(adjustments.map((e) => signOf(e.entry_type) * e.amount)),
    closingBalance: closing,
    entries: window,
  };
}

/** Monday 00:00 Port Moresby time for the week containing `date`. */
export function weekStart(date) {
  const d = new Date(date);
  const day = d.getUTCDay(); // 0 = Sunday
  const backTo = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - backTo);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
