// GENERATED FILE — DO NOT EDIT.
// Copied from packages/core/src by `npm run sync:core`.
// Edit the original; this copy exists only so Supabase can deploy it.

/**
 * The fare engine (spec §5).
 *
 * This is the most consequential file in the product. A passenger and a driver
 * settle up in cash, from memory, at the side of a road in Boroko — so the
 * number this returns has to be the number both of them saw, and it has to be
 * explicable months later.
 *
 * Two consequences run through everything here:
 *
 *   - **The fare is computed once and locked.** Traffic, detours and a longer
 *     actual route do not change it. `quote()` is called at booking and its
 *     output is stored on the booking row.
 *   - **Day or night is decided by the trip start time**, not the booking time.
 *     A 21:00 pickup booked at noon is a night fare.
 */

import { Timing } from './constants.js';
import { percentOf, roundUpToea } from './money.js';
import { isNightAt, isRateTableFresh } from './rates.js';

/** Thrown rather than returning a wrong price. Callers surface it as a retry. */
export class StaleRateTableError extends Error {
  constructor(fetchedAt) {
    super(
      `Rate table is older than ${Timing.RATE_TABLE_MAX_AGE_HOURS}h ` +
        `(fetched ${fetchedAt ? new Date(fetchedAt).toISOString() : 'never'}). ` +
        'Refusing to quote.',
    );
    this.name = 'StaleRateTableError';
    this.fetchedAt = fetchedAt;
  }
}

/**
 * Price a trip.
 *
 * @param {object}  args
 * @param {object}  args.rate       Normalised rate version (see `rates.js`).
 * @param {number}  args.distanceKm Route distance, pickup to destination.
 * @param {Date}    args.startAt    When the *trip starts*. Not when it is booked.
 * @returns {object} A breakdown, all money in whole toea.
 */
export function quote({ rate, distanceKm, startAt = new Date() }) {
  if (!rate) throw new TypeError('quote: no rate version supplied');
  if (!Number.isFinite(distanceKm) || distanceKm < 0) {
    throw new TypeError(`quote: bad distance: ${distanceKm}`);
  }

  const distanceCharge = Math.round(rate.perKm * distanceKm);
  const metered = rate.baseFare + distanceCharge;

  // The minimum is a floor on the *metered* fare, applied before the night
  // multiplier. Spec §5 sets the order and it matters: a 1 km run at 21:00
  // is minimum × 1.30, not minimum.
  const flooredToMinimum = metered < rate.minimumFare;
  const afterMinimum = flooredToMinimum ? rate.minimumFare : metered;

  const isNight = isNightAt(startAt, rate.nightStart, rate.nightEnd);
  const afterNight = isNight
    ? Math.round(afterMinimum * rate.nightMultiplier)
    : afterMinimum;

  const fare = roundUpToea(afterNight, rate.rounding);

  // Commission is charged on the locked fare, not on the cash actually
  // collected (spec §5, rule 4). A driver who gives a discount at the kerb is
  // spending his own margin, not the platform's.
  const commission = percentOf(fare, rate.commissionPct);

  return {
    rateVersionId: rate.id,
    classCode: rate.classCode,
    distanceKm,
    isNight,

    // Line items, in the order they are shown.
    baseFare: rate.baseFare,
    distanceCharge,
    metered,
    minimumFare: rate.minimumFare,
    flooredToMinimum,
    nightMultiplier: isNight ? rate.nightMultiplier : 1,
    nightUplift: afterNight - afterMinimum,
    roundingUplift: fare - afterNight,

    /** The locked, quoted fare. This is what the passenger pays in cash. */
    fare,
    /** Reserved line, zero at launch. Shown separately, never folded in. */
    serviceFee: rate.serviceFee,
    /** What the passenger hands over: fare plus any service fee. */
    total: fare + rate.serviceFee,

    /** What the vehicle owes the platform. Displayed to the driver. */
    commission,
    commissionPct: rate.commissionPct,
    /** What the driver keeps once commission is settled. */
    driverNet: fare - commission,
  };
}

/**
 * `quote()` with the staleness guard in front of it (spec §14).
 *
 * The customer app calls this. It refuses rather than guesses, so a handset
 * that has been out of coverage since yesterday cannot invent a price the
 * platform will not stand behind.
 */
export function quoteWithFreshTable({ rate, distanceKm, startAt, fetchedAt, now = new Date() }) {
  if (!isRateTableFresh(fetchedAt, now)) throw new StaleRateTableError(fetchedAt);
  return quote({ rate, distanceKm, startAt });
}

/**
 * One quote per class, for the vehicle list.
 *
 * The list shows a price against every vehicle before the customer has picked
 * one, and it does it without a single Directions call per row — the distance
 * is the one cached pickup-to-destination route, shared across every class.
 */
export function quoteAllClasses({ rates, distanceKm, startAt = new Date() }) {
  const out = {};
  for (const rate of rates) {
    out[rate.classCode] = quote({ rate, distanceKm, startAt });
  }
  return out;
}

/**
 * A plain-language account of how a fare was reached.
 *
 * Used on the driver's fare screen and in the admin dispute console. Every
 * dispute about money starts with "why is it this much", and the answer should
 * not require an engineer.
 */
export function explainQuote(q, formatKina) {
  const lines = [
    { label: 'Base fare', value: formatKina(q.baseFare) },
    {
      label: `Distance (${q.distanceKm.toFixed(1)} km)`,
      value: formatKina(q.distanceCharge),
    },
  ];
  if (q.flooredToMinimum) {
    lines.push({
      label: 'Minimum fare applied',
      value: formatKina(q.minimumFare),
      note: `Metered fare was ${formatKina(q.metered)}`,
    });
  }
  if (q.isNight) {
    lines.push({
      label: `Night rate (×${q.nightMultiplier})`,
      value: formatKina(q.nightUplift),
    });
  }
  if (q.roundingUplift > 0) {
    lines.push({ label: 'Rounding', value: formatKina(q.roundingUplift) });
  }
  if (q.serviceFee > 0) {
    lines.push({ label: 'Service fee', value: formatKina(q.serviceFee) });
  }
  return lines;
}
