/**
 * The booking state machine (spec §7).
 *
 * Every state change in the product goes through `applyEvent`. Nothing sets
 * `booking.state` directly — not the customer app, not the driver app, not the
 * admin console. That is what makes a driver's queued offline "arrived" tap
 * safe to replay hours later: the transition is either legal against the state
 * the row is actually in, or it is rejected with a reason.
 *
 * The one design decision worth stating outright: **a decline or a timeout is
 * terminal for that vehicle, and the customer is returned to the list.** The
 * platform never silently reassigns. The customer chose this vehicle, this
 * driver, this price, and quietly swapping the car underneath them is exactly
 * the behaviour the marketplace is supposed to be an alternative to.
 */

import { ACTIVE_STATES, BookingState, TERMINAL_STATES, Timing } from './constants.js';

export const BookingEvent = {
  REQUEST: 'REQUEST',
  ACCEPT: 'ACCEPT',
  DECLINE: 'DECLINE',
  EXPIRE: 'EXPIRE',
  RELEASE: 'RELEASE',
  START_EN_ROUTE: 'START_EN_ROUTE',
  ARRIVE: 'ARRIVE',
  START_TRIP: 'START_TRIP',
  COMPLETE: 'COMPLETE',
  CANCEL_CUSTOMER: 'CANCEL_CUSTOMER',
  CANCEL_DRIVER: 'CANCEL_DRIVER',
  MARK_NO_SHOW_CUSTOMER: 'MARK_NO_SHOW_CUSTOMER',
  MARK_NO_SHOW_DRIVER: 'MARK_NO_SHOW_DRIVER',
  RAISE_DISPUTE: 'RAISE_DISPUTE',
};

const S = BookingState;
const E = BookingEvent;

/**
 * Legal transitions, and the timestamp column each one stamps.
 *
 * `actor` is checked against the caller so a customer cannot mark himself
 * arrived, and a driver cannot cancel on the customer's behalf.
 */
const TRANSITIONS = {
  [S.DRAFT]: {
    [E.REQUEST]: { to: S.REQUESTED, stamp: 'requested_at', actor: 'customer' },
    [E.CANCEL_CUSTOMER]: { to: S.CANCELLED_BY_CUSTOMER, stamp: 'cancelled_at', actor: 'customer' },
  },
  [S.REQUESTED]: {
    [E.ACCEPT]: { to: S.CONFIRMED, stamp: 'confirmed_at', actor: 'driver' },
    [E.DECLINE]: { to: S.DECLINED, stamp: 'cancelled_at', actor: 'driver' },
    [E.EXPIRE]: { to: S.EXPIRED, stamp: 'cancelled_at', actor: 'system' },
    [E.CANCEL_CUSTOMER]: { to: S.CANCELLED_BY_CUSTOMER, stamp: 'cancelled_at', actor: 'customer' },
  },
  [S.CONFIRMED]: {
    [E.START_EN_ROUTE]: { to: S.DRIVER_EN_ROUTE, stamp: 'en_route_at', actor: 'driver' },
    [E.CANCEL_CUSTOMER]: { to: S.CANCELLED_BY_CUSTOMER, stamp: 'cancelled_at', actor: 'customer' },
    [E.CANCEL_DRIVER]: { to: S.CANCELLED_BY_DRIVER, stamp: 'cancelled_at', actor: 'driver' },
    [E.MARK_NO_SHOW_DRIVER]: { to: S.NO_SHOW_DRIVER, stamp: 'cancelled_at', actor: 'customer' },
    // A scheduled booking the driver never re-confirmed. Terminal, and it
    // costs the vehicle a strike — see `strikeFor`.
    [E.RELEASE]: { to: S.EXPIRED, stamp: 'cancelled_at', actor: 'system' },
    [E.RAISE_DISPUTE]: { to: S.DISPUTED, stamp: null, actor: 'any' },
  },
  [S.DRIVER_EN_ROUTE]: {
    [E.ARRIVE]: { to: S.ARRIVED, stamp: 'arrived_at', actor: 'driver' },
    [E.CANCEL_CUSTOMER]: { to: S.CANCELLED_BY_CUSTOMER, stamp: 'cancelled_at', actor: 'customer' },
    [E.CANCEL_DRIVER]: { to: S.CANCELLED_BY_DRIVER, stamp: 'cancelled_at', actor: 'driver' },
    [E.MARK_NO_SHOW_DRIVER]: { to: S.NO_SHOW_DRIVER, stamp: 'cancelled_at', actor: 'customer' },
    [E.RAISE_DISPUTE]: { to: S.DISPUTED, stamp: null, actor: 'any' },
  },
  [S.ARRIVED]: {
    [E.START_TRIP]: { to: S.IN_PROGRESS, stamp: 'started_at', actor: 'driver' },
    [E.MARK_NO_SHOW_CUSTOMER]: { to: S.NO_SHOW_CUSTOMER, stamp: 'cancelled_at', actor: 'driver' },
    [E.CANCEL_CUSTOMER]: { to: S.CANCELLED_BY_CUSTOMER, stamp: 'cancelled_at', actor: 'customer' },
    [E.CANCEL_DRIVER]: { to: S.CANCELLED_BY_DRIVER, stamp: 'cancelled_at', actor: 'driver' },
    [E.RAISE_DISPUTE]: { to: S.DISPUTED, stamp: null, actor: 'any' },
  },
  [S.IN_PROGRESS]: {
    [E.COMPLETE]: { to: S.COMPLETED, stamp: 'completed_at', actor: 'driver' },
    [E.RAISE_DISPUTE]: { to: S.DISPUTED, stamp: null, actor: 'any' },
  },
  [S.COMPLETED]: {
    [E.RAISE_DISPUTE]: { to: S.DISPUTED, stamp: null, actor: 'any' },
  },
  [S.NO_SHOW_CUSTOMER]: { [E.RAISE_DISPUTE]: { to: S.DISPUTED, stamp: null, actor: 'any' } },
  [S.NO_SHOW_DRIVER]: { [E.RAISE_DISPUTE]: { to: S.DISPUTED, stamp: null, actor: 'any' } },
  [S.CANCELLED_BY_CUSTOMER]: { [E.RAISE_DISPUTE]: { to: S.DISPUTED, stamp: null, actor: 'any' } },
  [S.CANCELLED_BY_DRIVER]: { [E.RAISE_DISPUTE]: { to: S.DISPUTED, stamp: null, actor: 'any' } },
  [S.DECLINED]: {},
  [S.EXPIRED]: {},
  [S.DISPUTED]: {},
};

export class IllegalTransitionError extends Error {
  constructor(state, event, why) {
    super(why ?? `Cannot ${event} a booking in ${state}`);
    this.name = 'IllegalTransitionError';
    this.state = state;
    this.event = event;
  }
}

export const isTerminal = (state) => TERMINAL_STATES.includes(state);
export const isActive = (state) => ACTIVE_STATES.includes(state);

/** Events legal from a state, ignoring time and payload guards. Drives the UI. */
export function eventsFrom(state) {
  return Object.keys(TRANSITIONS[state] ?? {});
}

/**
 * When the driver's window to accept closes.
 *
 * 90 seconds for an immediate booking; 30 minutes for a scheduled one, where
 * the driver is not sitting with the phone in his hand.
 */
export function acceptDeadline(booking) {
  const from = new Date(booking.requested_at ?? booking.created_at).getTime();
  const ms = booking.is_scheduled
    ? Timing.SCHEDULED_ACCEPT_WINDOW_MINUTES * 60_000
    : Timing.ACCEPT_WINDOW_SECONDS * 1000;
  return new Date(from + ms);
}

/** Seconds left on the countdown, floored at zero. */
export function secondsToAccept(booking, now = new Date()) {
  return Math.max(0, Math.ceil((acceptDeadline(booking).getTime() - now.getTime()) / 1000));
}

/**
 * The time the passenger was told to expect the car.
 *
 * For a scheduled booking that is the booked time. For an immediate one it is
 * the moment of confirmation — which is the only promise anyone made.
 */
function agreedPickupAt(booking) {
  if (booking.is_scheduled && booking.scheduled_for) return new Date(booking.scheduled_for);
  if (booking.confirmed_at) return new Date(booking.confirmed_at);
  return new Date(booking.requested_at ?? booking.created_at);
}

/** Guards that depend on the clock or on a required payload. */
function checkGuards(booking, event, payload, now) {
  switch (event) {
    case E.ACCEPT:
      if (now.getTime() > acceptDeadline(booking).getTime()) {
        return 'The time to accept this booking has run out';
      }
      return null;

    case E.DECLINE:
      // Spec §7 makes the reason mandatory. Decline reasons are how the
      // platform finds out which suburbs are underserved, and at which hours.
      if (!payload?.reason) return 'A decline reason is required';
      if (payload.reason === 'OTHER' && !payload.note?.trim()) {
        return 'Choosing Other requires a note';
      }
      return null;

    case E.EXPIRE:
      if (now.getTime() < acceptDeadline(booking).getTime()) {
        return 'The accept window has not closed yet';
      }
      return null;

    case E.RELEASE: {
      if (!booking.is_scheduled) return 'Only scheduled bookings are released';
      const cutoff =
        new Date(booking.scheduled_for).getTime() -
        Timing.RELEASE_BEFORE_MINUTES * 60_000;
      if (now.getTime() < cutoff) return 'Too early to release this booking';
      if (booking.reconfirmed_at) return 'The driver has re-confirmed';
      return null;
    }

    case E.MARK_NO_SHOW_CUSTOMER: {
      const waited = now.getTime() - new Date(booking.arrived_at).getTime();
      if (waited < Timing.CUSTOMER_NO_SHOW_GRACE_MINUTES * 60_000) {
        return `You must wait ${Timing.CUSTOMER_NO_SHOW_GRACE_MINUTES} minutes at the pickup point first`;
      }
      return null;
    }

    case E.MARK_NO_SHOW_DRIVER: {
      const late = now.getTime() - agreedPickupAt(booking).getTime();
      if (late < Timing.DRIVER_NO_SHOW_GRACE_MINUTES * 60_000) {
        return `You can report a no-show ${Timing.DRIVER_NO_SHOW_GRACE_MINUTES} minutes after the agreed time`;
      }
      return null;
    }

    case E.CANCEL_CUSTOMER:
    case E.CANCEL_DRIVER:
      if (!payload?.reason) return 'A cancellation reason is required';
      return null;

    case E.RAISE_DISPUTE:
      if (!payload?.category) return 'A dispute category is required';
      return null;

    default:
      return null;
  }
}

/**
 * Can this event fire right now? Returns `{ ok, error }` without throwing, so
 * a screen can grey a button out instead of catching.
 */
export function canApply(booking, event, { actor = 'system', payload, now = new Date() } = {}) {
  const legal = TRANSITIONS[booking.state]?.[event];
  if (!legal) {
    return { ok: false, error: `Cannot ${event} a booking that is ${booking.state}` };
  }
  if (legal.actor !== 'any' && legal.actor !== actor) {
    return { ok: false, error: `Only the ${legal.actor} can do that` };
  }
  const guard = checkGuards(booking, event, payload, now);
  if (guard) return { ok: false, error: guard };
  return { ok: true, to: legal.to };
}

/**
 * Apply an event, returning a new booking. Never mutates the input — the
 * offline queue replays these, and a mutated row would corrupt the local
 * mirror on a failed sync.
 *
 * `now` is always passed in rather than read from the clock, because a queued
 * driver action must be recorded with the time it actually happened, not the
 * time the connection came back (spec §14).
 */
export function applyEvent(booking, event, { actor = 'system', payload = {}, now = new Date() } = {}) {
  const verdict = canApply(booking, event, { actor, payload, now });
  if (!verdict.ok) throw new IllegalTransitionError(booking.state, event, verdict.error);

  const legal = TRANSITIONS[booking.state][event];
  const next = { ...booking, state: legal.to };
  if (legal.stamp) next[legal.stamp] = now.toISOString();

  switch (event) {
    case E.DECLINE:
      next.decline_reason = payload.reason;
      next.decline_note = payload.note ?? null;
      break;
    case E.CANCEL_CUSTOMER:
      next.cancelled_by = 'CUSTOMER';
      next.cancel_reason = payload.reason;
      break;
    case E.CANCEL_DRIVER:
      next.cancelled_by = 'DRIVER';
      next.cancel_reason = payload.reason;
      break;
    case E.RELEASE:
      next.cancelled_by = 'SYSTEM';
      next.cancel_reason = 'NOT_RECONFIRMED';
      next.released_at = now.toISOString();
      break;
    case E.MARK_NO_SHOW_CUSTOMER:
      next.cancelled_by = 'DRIVER';
      next.cancel_reason = 'NO_SHOW_CUSTOMER';
      break;
    case E.MARK_NO_SHOW_DRIVER:
      next.cancelled_by = 'CUSTOMER';
      next.cancel_reason = 'NO_SHOW_DRIVER';
      break;
    case E.RAISE_DISPUTE:
      next.dispute_category = payload.category;
      next.state_before_dispute = booking.state;
      break;
    default:
      break;
  }
  return next;
}

/**
 * What a cancellation costs the person who did it (spec §7).
 *
 * Note what is *not* here: money. Commission is never charged on a
 * cancellation or a no-show. These are conduct records, and they are settled
 * by an admin having a conversation, not by a fee. That is the right call for
 * a market where a K10 penalty is a real amount of money to a driver.
 */
export function cancellationPolicy(fromState, event) {
  if (event === E.CANCEL_CUSTOMER) {
    if (fromState === S.DRAFT || fromState === S.REQUESTED) {
      return { logged: false, weight: 0, against: null, note: 'Free — no driver had accepted' };
    }
    if (fromState === S.CONFIRMED) {
      return { logged: true, weight: 1, against: 'CUSTOMER', note: 'Cancelled after the driver accepted' };
    }
    // En route or waiting at the pickup: the driver has burned fuel and time.
    return { logged: true, weight: 2, against: 'CUSTOMER', note: 'Cancelled after the driver set off' };
  }
  if (event === E.CANCEL_DRIVER) {
    return { logged: true, weight: 1, against: 'VEHICLE', note: 'Driver cancelled after accepting' };
  }
  if (event === E.MARK_NO_SHOW_CUSTOMER) {
    return { logged: true, weight: 1, against: 'CUSTOMER', note: 'Passenger did not show' };
  }
  if (event === E.MARK_NO_SHOW_DRIVER) {
    return { logged: true, weight: 1, against: 'VEHICLE', note: 'Driver did not arrive' };
  }
  if (event === E.RELEASE) {
    // Spec §10: a late release counts as a driver no-show against the vehicle.
    return { logged: true, weight: 1, against: 'VEHICLE', note: 'Scheduled booking not re-confirmed' };
  }
  if (event === E.DECLINE || event === E.EXPIRE) {
    // Declining is allowed and is not a strike. Turning a decline into a
    // penalty just teaches drivers to accept and then cancel, which is worse
    // for the passenger standing on the roadside.
    return { logged: true, weight: 0, against: null, note: 'Logged for reporting only' };
  }
  return { logged: false, weight: 0, against: null, note: null };
}

/** Commission is only ever charged on a completed trip. */
export function isCommissionable(state) {
  return state === S.COMPLETED;
}

/**
 * A human booking reference: `WR-4K7P2M`.
 *
 * Read aloud over a bad phone line, so the alphabet leaves out the characters
 * that sound or look alike: I, L, O, S, U, 0, 1, 5.
 */
const REF_ALPHABET = '234679ABCDEFGHJKMNPQRTVWXYZ';
export function makeReference(random = Math.random) {
  let out = '';
  for (let i = 0; i < 6; i += 1) {
    out += REF_ALPHABET[Math.floor(random() * REF_ALPHABET.length)];
  }
  return `WR-${out}`;
}

/** Customer-facing label for a state. The driver app has its own wording. */
export function customerStateLabel(state) {
  return {
    [S.DRAFT]: 'Not booked yet',
    [S.REQUESTED]: 'Waiting for the driver',
    [S.CONFIRMED]: 'Booking confirmed',
    [S.DECLINED]: 'Driver declined',
    [S.EXPIRED]: 'Driver did not respond',
    [S.DRIVER_EN_ROUTE]: 'Driver on the way',
    [S.ARRIVED]: 'Driver has arrived',
    [S.IN_PROGRESS]: 'On the trip',
    [S.COMPLETED]: 'Completed',
    [S.CANCELLED_BY_CUSTOMER]: 'You cancelled',
    [S.CANCELLED_BY_DRIVER]: 'Driver cancelled',
    [S.NO_SHOW_CUSTOMER]: 'Marked as no-show',
    [S.NO_SHOW_DRIVER]: 'Driver did not arrive',
    [S.DISPUTED]: 'Under review',
  }[state] ?? state;
}
