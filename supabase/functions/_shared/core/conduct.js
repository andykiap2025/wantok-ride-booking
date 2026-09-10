// GENERATED FILE — DO NOT EDIT.
// Copied from packages/core/src by `npm run sync:core`.
// Edit the original; this copy exists only so Supabase can deploy it.

/**
 * Conduct records and the flags they raise (spec §7).
 *
 * No money changes hands over a cancellation. In a market where K10 is real
 * money to a driver, a penalty fee is a blunt instrument that mostly teaches
 * people to game the state machine — accept and then go quiet, or claim a
 * no-show. What the platform does instead is *count*, and put a human in the
 * loop when the count says something.
 */

import { BookingState, Thresholds } from './constants.js';

export const StrikeType = {
  DRIVER_CANCEL: 'DRIVER_CANCEL',
  DRIVER_NO_SHOW: 'DRIVER_NO_SHOW',
  CUSTOMER_CANCEL: 'CUSTOMER_CANCEL',
  CUSTOMER_NO_SHOW: 'CUSTOMER_NO_SHOW',
};

/** Terminal states that leave a mark, and on whom. */
export function strikeFor(booking) {
  switch (booking.state) {
    case BookingState.CANCELLED_BY_DRIVER:
      return { type: StrikeType.DRIVER_CANCEL, against: 'VEHICLE', weight: 1 };
    case BookingState.NO_SHOW_DRIVER:
      return { type: StrikeType.DRIVER_NO_SHOW, against: 'VEHICLE', weight: 1 };
    case BookingState.NO_SHOW_CUSTOMER:
      return { type: StrikeType.CUSTOMER_NO_SHOW, against: 'CUSTOMER', weight: 1 };
    case BookingState.EXPIRED:
      // A released scheduled booking. An unanswered 90-second request is not a
      // strike; a booking the driver held for a week and dropped is.
      return booking.released_at
        ? { type: StrikeType.DRIVER_NO_SHOW, against: 'VEHICLE', weight: 1 }
        : null;
    case BookingState.CANCELLED_BY_CUSTOMER: {
      if (!booking.confirmed_at) return null; // cancelled before anyone accepted: free
      // Double weight once the driver has actually set off.
      const weight = booking.en_route_at ? 2 : 1;
      return { type: StrikeType.CUSTOMER_CANCEL, against: 'CUSTOMER', weight };
    }
    default:
      return null;
  }
}

function withinDays(record, days, now) {
  const cutoff = now.getTime() - days * 86_400_000;
  return new Date(record.created_at ?? record.at).getTime() >= cutoff;
}

/**
 * Three driver cancellations or no-shows in a rolling 7 days flags the vehicle
 * for admin review (spec §7).
 *
 * Note what this returns: a *flag*, not a suspension. The right response to a
 * driver having a bad week might be a phone call, not removal, and the system
 * should not pre-empt that conversation.
 */
export function driverReviewFlag(records, now = new Date()) {
  const relevant = records.filter(
    (r) =>
      [StrikeType.DRIVER_CANCEL, StrikeType.DRIVER_NO_SHOW].includes(r.type) &&
      withinDays(r, Thresholds.DRIVER_STRIKE_WINDOW_DAYS, now),
  );
  const count = relevant.reduce((sum, r) => sum + (r.weight ?? 1), 0);
  return {
    flagged: count >= Thresholds.DRIVER_STRIKES,
    count,
    threshold: Thresholds.DRIVER_STRIKES,
    windowDays: Thresholds.DRIVER_STRIKE_WINDOW_DAYS,
    records: relevant,
  };
}

/**
 * Three customer no-shows in 30 days blocks new bookings until they speak to
 * admin (spec §7).
 *
 * A block, not a ban — the customer app tells them exactly why and how to fix
 * it. A silent failure to book is how you lose someone permanently over a
 * misunderstanding.
 */
export function customerBookingBlock(records, now = new Date()) {
  const relevant = records.filter(
    (r) => r.type === StrikeType.CUSTOMER_NO_SHOW && withinDays(r, Thresholds.CUSTOMER_NO_SHOW_WINDOW_DAYS, now),
  );
  const count = relevant.reduce((sum, r) => sum + (r.weight ?? 1), 0);
  const blocked = count >= Thresholds.CUSTOMER_NO_SHOWS;
  return {
    blocked,
    count,
    threshold: Thresholds.CUSTOMER_NO_SHOWS,
    windowDays: Thresholds.CUSTOMER_NO_SHOW_WINDOW_DAYS,
    message: blocked
      ? 'New bookings are paused on your account after three missed pickups. Call Wantok Ride support to sort it out.'
      : null,
    records: relevant,
  };
}

/** The one call the customer app makes before letting someone book. */
export function canBook({ profile, records, now = new Date() }) {
  if (profile.status && profile.status !== 'ACTIVE') {
    return { ok: false, code: 'ACCOUNT', error: 'This account is not active. Contact support.' };
  }
  if (!profile.emergency_verified_at) {
    // Spec §10: mandatory, verified by test SMS, before the account can book
    // or drive. Not a settings-screen option.
    return {
      ok: false,
      code: 'EMERGENCY_CONTACT',
      error: 'Add and verify an emergency contact before booking',
    };
  }
  const block = customerBookingBlock(records, now);
  if (block.blocked) return { ok: false, code: 'NO_SHOWS', error: block.message };
  return { ok: true };
}

/** The same gate on the driver side. */
export function canDrive({ profile, vehicle, now = new Date() }) {
  if (!profile.emergency_verified_at) {
    return {
      ok: false,
      code: 'EMERGENCY_CONTACT',
      error: 'Add and verify an emergency contact before going online',
    };
  }
  if (!vehicle) return { ok: false, code: 'NO_VEHICLE', error: 'No vehicle assigned to you' };
  if (vehicle.status !== 'APPROVED') {
    return {
      ok: false,
      code: 'VEHICLE_STATUS',
      error: vehicleStatusMessage(vehicle.status),
      status: vehicle.status,
    };
  }
  return { ok: true };
}

/** Plain wording for a vehicle status, for the driver's home screen. */
export function vehicleStatusMessage(status) {
  return {
    DRAFT: 'This vehicle has not been submitted yet',
    PENDING_DOCS: 'Waiting on documents and photos',
    PENDING_INSPECTION: 'Waiting for the physical inspection at Skyworks',
    APPROVED: 'Approved and ready to work',
    REJECTED: 'This vehicle was not approved. See the reason and re-submit.',
    SUSPENDED_UNPAID: 'Off the app until the commission balance is paid',
    SUSPENDED_DOCS: 'Off the app: a document has expired. Upload a current one.',
    SUSPENDED_ADMIN: 'Suspended by Wantok Ride. Contact support.',
    RETIRED: 'This vehicle has been retired',
  }[status] ?? status;
}
