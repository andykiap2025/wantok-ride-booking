/**
 * Kina arithmetic.
 *
 * Everything inside the engine is an integer count of **toea** (1 kina = 100
 * toea). Fares, commission and ledger balances are money, and money that has
 * been through a float is money you cannot reconcile against a bank statement.
 * Convert at the edges — `toToea` on the way in, `formatKina` on the way out —
 * and never in between.
 */

export const TOEA_PER_KINA = 100;

/** Kina (number or numeric string, e.g. 3.50) to whole toea. */
export function toToea(kina) {
  const n = typeof kina === 'string' ? Number(kina) : kina;
  if (!Number.isFinite(n)) {
    throw new TypeError(`toToea: not a number: ${kina}`);
  }
  // Round rather than truncate: 3.50 * 100 is 350.00000000000006 in binary
  // floating point, and Math.trunc would turn that into K3.49.
  return Math.round(n * TOEA_PER_KINA);
}

/** Whole toea back to a kina number. Display only — do not do sums on this. */
export function toKina(toea) {
  return toea / TOEA_PER_KINA;
}

/**
 * "K25.50". The K goes in front with no space, which is how it is written on
 * a PNG receipt.
 */
export function formatKina(toea, { decimals = 2, sign = false } = {}) {
  const negative = toea < 0;
  const abs = Math.abs(toea);
  const body = (abs / TOEA_PER_KINA).toFixed(decimals);
  const prefix = negative ? '-K' : sign ? '+K' : 'K';
  return `${prefix}${body}`;
}

/** "K25" — for list tiles where the toea are noise. Always rounds up. */
export function formatKinaShort(toea) {
  return `K${Math.ceil(toea / TOEA_PER_KINA)}`;
}

/**
 * Round *up* to the nearest `stepKina` (spec §5: `rounding: 5`).
 *
 * Rounding up is deliberate and always in the driver's favour — a fare of
 * K21.40 with a K5 step is K25, not K20. A step of 0 means no rounding.
 */
export function roundUpToea(toea, stepKina) {
  const step = toToea(stepKina || 0);
  if (step <= 0) return Math.round(toea);
  return Math.ceil(toea / step) * step;
}

/** Percentage of an amount, rounded to the nearest toea. */
export function percentOf(toea, pct) {
  return Math.round((toea * pct) / 100);
}

/** Sum a list of toea amounts. Empty list is zero, not NaN. */
export function sumToea(amounts) {
  return amounts.reduce((total, n) => total + n, 0);
}
