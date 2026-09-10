/**
 * Future bookings (spec §7, future flow).
 *
 * A scheduled ride is a promise made days early by someone who will not be
 * thinking about it again until they are standing outside with a suitcase. The
 * spec's instruction is the design brief for this whole file:
 *
 *   > Never let a scheduled booking fail silently on the morning.
 *
 * So the driver is asked to re-confirm twice, and if he has not by 45 minutes
 * out the booking is *released* — taken off him and handed back to the
 * customer with time still on the clock to book someone else.
 */

import { BookingState, Timing } from './constants.js';
import { PNG_UTC_OFFSET_MINUTES, pngLocalParts } from './rates.js';

/** Is this a legal pickup time to book? (min 1 hour out, max 14 days) */
export function validateScheduledTime(scheduledFor, now = new Date()) {
  const when = new Date(scheduledFor);
  if (Number.isNaN(when.getTime())) return { ok: false, error: 'Pick a valid date and time' };

  const leadMinutes = (when.getTime() - now.getTime()) / 60_000;
  if (leadMinutes < Timing.MIN_LEAD_MINUTES) {
    return {
      ok: false,
      error: `Scheduled rides must be at least ${Timing.MIN_LEAD_MINUTES} minutes ahead. For sooner than that, book now.`,
    };
  }
  if (leadMinutes > Timing.MAX_LEAD_DAYS * 24 * 60) {
    return { ok: false, error: `You can book up to ${Timing.MAX_LEAD_DAYS} days ahead` };
  }
  return { ok: true, leadMinutes };
}

/** The earliest bookable slot, rounded up to a clean 5 minutes. */
export function earliestSlot(now = new Date()) {
  const t = new Date(now.getTime() + Timing.MIN_LEAD_MINUTES * 60_000);
  const ms = 5 * 60_000;
  return new Date(Math.ceil(t.getTime() / ms) * ms);
}

export function latestSlot(now = new Date()) {
  return new Date(now.getTime() + Timing.MAX_LEAD_DAYS * 86_400_000);
}

/** 18:00 Port Moresby, the evening before a pickup, as a UTC instant. */
export function eveningBefore(scheduledFor) {
  const when = new Date(scheduledFor);
  const local = pngLocalParts(when);
  // Build 18:00 local on the local calendar day, then step back one day.
  const localMidnightUtc = Date.UTC(local.year, local.month - 1, local.day) - PNG_UTC_OFFSET_MINUTES * 60_000;
  const eveningLocalUtc = localMidnightUtc + Timing.EVENING_REMINDER_HOUR * 3_600_000;
  return new Date(eveningLocalUtc - 86_400_000);
}

/**
 * Every notification a scheduled booking will fire, with the time it fires.
 *
 * Generating the whole schedule up front means the reminder job is a simple
 * "what is due" query rather than a pile of conditionals, and it means the
 * customer app can show "we will remind you at 18:00 tomorrow".
 */
export function reminderSchedule(booking) {
  if (!booking.is_scheduled || !booking.scheduled_for) return [];
  const pickup = new Date(booking.scheduled_for).getTime();
  const out = [];

  const evening = eveningBefore(booking.scheduled_for);
  // Only worth sending if it is actually before the pickup and in the future
  // relative to the booking — a ride booked at 20:00 for 07:00 tomorrow skips it.
  if (evening.getTime() > new Date(booking.created_at ?? booking.requested_at).getTime()) {
    out.push({
      kind: 'DRIVER_EVENING_REMINDER',
      audience: 'DRIVER',
      at: evening,
      requiresReconfirm: true,
    });
  }

  out.push({
    kind: 'DRIVER_HOUR_REMINDER',
    audience: 'DRIVER',
    at: new Date(pickup - Timing.REMINDER_BEFORE_MINUTES * 60_000),
    requiresReconfirm: true,
  });

  out.push({
    kind: 'CUSTOMER_REMINDER',
    audience: 'CUSTOMER',
    at: new Date(pickup - Timing.CUSTOMER_REMINDER_BEFORE_MINUTES * 60_000),
    requiresReconfirm: false,
  });

  out.push({
    kind: 'RELEASE_CHECK',
    audience: 'SYSTEM',
    at: new Date(pickup - Timing.RELEASE_BEFORE_MINUTES * 60_000),
    requiresReconfirm: false,
  });

  return out.filter((r) => r.at.getTime() < pickup).sort((a, b) => a.at - b.at);
}

/** The moment the booking is taken off the driver if he has gone quiet. */
export function releaseDeadline(booking) {
  return new Date(new Date(booking.scheduled_for).getTime() - Timing.RELEASE_BEFORE_MINUTES * 60_000);
}

/**
 * Should this booking be released now?
 *
 * The test is re-confirmation, not acceptance. A driver who accepted six days
 * ago and has ignored both reminders has not confirmed anything the customer
 * can rely on this morning.
 */
export function shouldRelease(booking, now = new Date()) {
  if (!booking.is_scheduled) return false;
  if (booking.state !== BookingState.CONFIRMED) return false;
  if (booking.reconfirmed_at) {
    // A re-confirm only counts if it came after the evening reminder went out.
    const evening = eveningBefore(booking.scheduled_for).getTime();
    if (new Date(booking.reconfirmed_at).getTime() >= evening) return false;
  }
  return now.getTime() >= releaseDeadline(booking).getTime();
}

/**
 * What the driver app should be asking for right now.
 *
 * Returns null when there is nothing to do, so the driver's home screen shows
 * a re-confirm banner only in the window where it means something.
 */
export function pendingReconfirm(booking, now = new Date()) {
  if (!booking.is_scheduled || booking.state !== BookingState.CONFIRMED) return null;
  const pickup = new Date(booking.scheduled_for).getTime();
  const release = releaseDeadline(booking).getTime();
  if (now.getTime() >= pickup) return null;

  const evening = eveningBefore(booking.scheduled_for).getTime();
  const reconfirmed = booking.reconfirmed_at ? new Date(booking.reconfirmed_at).getTime() : 0;
  if (reconfirmed >= evening) return null;
  if (now.getTime() < evening) return null;

  const minutesLeft = Math.round((release - now.getTime()) / 60_000);
  return {
    dueBy: new Date(release),
    minutesLeft,
    urgent: minutesLeft <= Timing.REMINDER_BEFORE_MINUTES,
    message:
      minutesLeft <= Timing.REMINDER_BEFORE_MINUTES
        ? 'Re-confirm now or this booking goes back to the customer'
        : 'Please re-confirm tomorrow morning’s booking',
  };
}

/** "Tomorrow, 7:15 AM" — how a pickup time is written throughout the apps. */
export function formatPickup(scheduledFor, now = new Date()) {
  const when = new Date(scheduledFor);
  const a = pngLocalParts(when);
  const b = pngLocalParts(now);
  const days = Math.round(
    (Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day)) / 86_400_000,
  );

  const hour12 = a.hour % 12 === 0 ? 12 : a.hour % 12;
  const time = `${hour12}:${String(a.minute).padStart(2, '0')} ${a.hour < 12 ? 'AM' : 'PM'}`;

  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Tomorrow, ${time}`;

  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (days > 1 && days < 7) return `${WEEKDAYS[a.weekday]}, ${time}`;
  return `${a.day} ${MONTHS[a.month - 1]}, ${time}`;
}
