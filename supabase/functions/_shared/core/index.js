// GENERATED FILE — DO NOT EDIT.
// Copied from packages/core/src by `npm run sync:core`.
// Edit the original; this copy exists only so Supabase can deploy it.

/**
 * @wantok/core — the Wantok Ride domain engine.
 *
 * Every rule the spec states about money, state, trust or safety lives here,
 * in plain JavaScript with no dependencies and no I/O. The customer app, the
 * driver app, the admin console and the Supabase edge functions all import the
 * same functions, so there is exactly one implementation of "what is this trip
 * worth" and one of "may this booking be cancelled".
 *
 * The rule for this package: **it never reaches for a clock, a network or a
 * database.** `now` is always a parameter. That is what makes the whole thing
 * testable, and what makes a driver's offline action replayable with the
 * timestamp it actually happened at.
 */

export * from './constants.js';
export * from './money.js';
export * from './geo.js';
export * from './rates.js';
export * from './fare.js';
export * from './booking.js';
export * from './ledger.js';
export * from './reviews.js';
export * from './documents.js';
export * from './scheduling.js';
export * from './dispatch.js';
export * from './conduct.js';
export * from './sos.js';
export * from './auth.js';
