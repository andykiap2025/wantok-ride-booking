// GENERATED FILE — DO NOT EDIT.
// Copied from packages/core/src by `npm run sync:core`.
// Edit the original; this copy exists only so Supabase can deploy it.

/**
 * Rate tables (spec §5).
 *
 * Three rules drive everything in this file:
 *
 *   1. Rates are *versioned, never overwritten*. A booking stores the id of the
 *      version it was quoted from, so a fare from March can still be explained
 *      in September.
 *   2. Rates are fetched from the backend. Never bake a price into an APK.
 *   3. A quote is never produced from a table older than 24 hours.
 */

import { Timing } from './constants.js';
import { toToea } from './money.js';

/**
 * Papua New Guinea is UTC+10 all year — no daylight saving.
 *
 * The night window has to be evaluated in Port Moresby local time, not the
 * handset's. A phone left on Brisbane time would otherwise price an 05:30
 * airport run as a night fare, and the driver and the app would disagree about
 * the money in front of the passenger.
 */
export const PNG_UTC_OFFSET_MINUTES = 600;

/** Local wall-clock parts in Port Moresby for an instant. */
export function pngLocalParts(date) {
  const shifted = new Date(date.getTime() + PNG_UTC_OFFSET_MINUTES * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

/** Minutes since midnight, Port Moresby time. */
export function pngMinutesOfDay(date) {
  const { hour, minute } = pngLocalParts(date);
  return hour * 60 + minute;
}

/** "20:00" to minutes since midnight. */
export function parseClock(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) {
    throw new TypeError(`parseClock: not a HH:MM time: ${hhmm}`);
  }
  return h * 60 + m;
}

/**
 * Is this instant inside the night window?
 *
 * The window wraps midnight (20:00 to 05:00), so it is two ranges, not one.
 * Boundaries: `night_start` is inclusive, `night_end` is exclusive. A trip
 * starting at exactly 20:00 is night; one starting at exactly 05:00 is not.
 */
export function isNightAt(date, nightStart, nightEnd) {
  const now = pngMinutesOfDay(date);
  const start = parseClock(nightStart);
  const end = parseClock(nightEnd);
  if (start === end) return false; // zero-length window: no night rate
  if (start < end) return now >= start && now < end; // same-day window
  return now >= start || now < end; // wraps midnight
}

/**
 * Turn a `rate_versions` row (kina decimals, as stored) into the toea-integer
 * shape the fare engine works in.
 */
export function normaliseRateVersion(row) {
  return {
    id: row.id,
    classCode: row.class_code ?? row.classCode,
    baseFare: toToea(row.base_fare ?? row.baseFare),
    perKm: toToea(row.per_km ?? row.perKm),
    minimumFare: toToea(row.minimum_fare ?? row.minimumFare),
    nightMultiplier: Number(row.night_multiplier ?? row.nightMultiplier),
    nightStart: row.night_start ?? row.nightStart,
    nightEnd: row.night_end ?? row.nightEnd,
    rounding: Number(row.rounding ?? 0),
    serviceFee: toToea(row.service_fee ?? row.serviceFee ?? 0),
    commissionPct: Number(row.commission_pct ?? row.commissionPct),
    effectiveFrom: new Date(row.effective_from ?? row.effectiveFrom),
  };
}

/**
 * The rate version in force for a class at a given instant.
 *
 * "In force" means the newest version whose `effective_from` has already
 * passed. A version dated into the future is staged, not live — which is how
 * admin schedules a price change without standing over the console at midnight.
 */
export function resolveRateVersion(versions, classCode, at = new Date()) {
  const candidates = versions
    .filter((v) => (v.classCode ?? v.class_code) === classCode)
    .map((v) => (v.effectiveFrom instanceof Date ? v : normaliseRateVersion(v)))
    .filter((v) => v.effectiveFrom.getTime() <= at.getTime())
    .sort((a, b) => b.effectiveFrom - a.effectiveFrom);
  return candidates[0] ?? null;
}

/**
 * May we quote from this cached table? (spec §14)
 *
 * Offline-first means the handset holds a copy of the rate table, but a stale
 * copy quotes a price the platform will not honour. Past 24 hours the customer
 * app must refuse to quote and say so, rather than guess.
 */
export function isRateTableFresh(fetchedAt, now = new Date()) {
  if (!fetchedAt) return false;
  const ageHours = (now.getTime() - new Date(fetchedAt).getTime()) / 3_600_000;
  return ageHours >= 0 && ageHours < Timing.RATE_TABLE_MAX_AGE_HOURS;
}
