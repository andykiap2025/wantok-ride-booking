// GENERATED FILE — DO NOT EDIT.
// Copied from packages/core/src by `npm run sync:core`.
// Edit the original; this copy exists only so Supabase can deploy it.

/**
 * Two-way reviews (spec §9).
 *
 * The whole design turns on one rule: **neither side sees the other's rating
 * until both have submitted, or 48 hours have passed.** Without the blind
 * window, a driver who gets two stars gives two stars back, and within a month
 * every rating in the system is a 5 and the ratings mean nothing.
 */

import { CUSTOMER_REVIEW_TAGS, DRIVER_REVIEW_TAGS, Thresholds, Timing, BookingState } from './constants.js';

export const SubjectType = { VEHICLE: 'VEHICLE', CUSTOMER: 'CUSTOMER' };

/** Who may be reviewed, and with which tag vocabulary. */
export function tagsFor(subjectType) {
  return subjectType === SubjectType.VEHICLE ? DRIVER_REVIEW_TAGS : CUSTOMER_REVIEW_TAGS;
}

/**
 * May this person review this booking? (spec §9)
 *
 * Only a completed trip, one review per side, and only by someone who was
 * actually on it. A no-show or a cancellation produces no review — there was
 * no trip to have an opinion about.
 */
export function canReview({ booking, authorId, existingReviews = [], now = new Date() }) {
  if (booking.state !== BookingState.COMPLETED) {
    return { ok: false, error: 'Only a completed trip can be reviewed' };
  }
  const isCustomer = booking.customer_id === authorId;
  const isDriver = booking.driver_id === authorId;
  if (!isCustomer && !isDriver) {
    return { ok: false, error: 'You were not on this trip' };
  }
  if (existingReviews.some((r) => r.booking_id === booking.id && r.author_id === authorId)) {
    return { ok: false, error: 'You have already reviewed this trip' };
  }
  return {
    ok: true,
    subjectType: isCustomer ? SubjectType.VEHICLE : SubjectType.CUSTOMER,
    subjectId: isCustomer ? booking.vehicle_id : booking.customer_id,
  };
}

export function validateReview({ stars, comment, tags = [], subjectType }) {
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    return { ok: false, error: 'Rating must be between 1 and 5 stars' };
  }
  const allowed = new Set(tagsFor(subjectType).map((t) => t.code));
  const bad = tags.find((t) => !allowed.has(t));
  if (bad) return { ok: false, error: `Unknown tag: ${bad}` };
  if (comment && comment.length > 500) {
    return { ok: false, error: 'Comment is too long' };
  }
  return { ok: true };
}

/**
 * Has the blind window lifted for this booking?
 *
 * Both sides in, or 48 hours since completion. The 48-hour escape hatch is
 * what stops a review sitting invisible forever because the other party never
 * opened the app again.
 */
export function isUnblinded({ booking, reviews, now = new Date() }) {
  const forBooking = reviews.filter((r) => r.booking_id === booking.id);
  const bothIn =
    forBooking.some((r) => r.author_id === booking.customer_id) &&
    forBooking.some((r) => r.author_id === booking.driver_id);
  if (bothIn) return true;
  if (!booking.completed_at) return false;
  const elapsedHours =
    (now.getTime() - new Date(booking.completed_at).getTime()) / 3_600_000;
  return elapsedHours >= Timing.REVIEW_BLIND_HOURS;
}

/**
 * Reviews this viewer is allowed to see right now.
 *
 * Your own review is always visible to you — you wrote it. Everyone else's is
 * gated on the blind window and on not having been hidden by admin.
 */
export function visibleReviews({ reviews, bookings, viewerId, now = new Date() }) {
  const byId = new Map(bookings.map((b) => [b.id, b]));
  return reviews.filter((r) => {
    if (r.visible === false) return false;
    if (r.author_id === viewerId) return true;
    const booking = byId.get(r.booking_id);
    if (!booking) return true; // no booking context: treat as historical, show it
    return isUnblinded({ booking, reviews, now });
  });
}

/** Average and count, rounded to one decimal for display. */
export function aggregate(reviews) {
  const live = reviews.filter((r) => r.visible !== false);
  if (!live.length) return { avg: null, count: 0, stars: null };
  const total = live.reduce((sum, r) => sum + r.stars, 0);
  const avg = total / live.length;
  return { avg, count: live.length, stars: Math.round(avg * 10) / 10 };
}

/** How the stars break down, for the bars on a vehicle profile. */
export function starDistribution(reviews) {
  const buckets = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of reviews) {
    if (r.visible !== false) buckets[r.stars] += 1;
  }
  return buckets;
}

/**
 * Should admin look at this vehicle? (spec §9)
 *
 * Below 3.0 across its last 20 trips. Deliberately a *window*, not a lifetime
 * average — a vehicle with 400 good trips and a driver who has just started
 * cutting corners should still surface.
 */
export function vehicleNeedsReview(recentReviews, {
  floor = Thresholds.VEHICLE_RATING_FLOOR,
  window = Thresholds.VEHICLE_RATING_WINDOW_TRIPS,
} = {}) {
  const recent = [...recentReviews]
    .filter((r) => r.visible !== false)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, window);

  // Not enough history to judge. Flagging on three trips would punish a new
  // vehicle for one bad morning.
  if (recent.length < 5) return { flagged: false, avg: null, sample: recent.length };

  const { avg } = aggregate(recent);
  return { flagged: avg < floor, avg, sample: recent.length, floor };
}

/**
 * Hide an abusive review (spec §9).
 *
 * Admin may hide, but the action is logged and the rating recalculates. There
 * is no delete — a hidden review is still evidence in a dispute.
 */
export function hideReview(review, { adminId, reason, now = new Date() }) {
  return {
    ...review,
    visible: false,
    hidden_by: adminId,
    hidden_reason: reason,
    hidden_at: now.toISOString(),
  };
}

/**
 * The rating a driver sees when a request comes in (spec §9).
 *
 * A brand-new customer has no rating, and that must read as "new", not as
 * "zero stars". Drivers decline low ratings; they should not decline someone
 * who simply has not ridden yet.
 */
export function customerBadge(profile) {
  if (!profile.rating_count) return { label: 'New passenger', stars: null, isNew: true };
  return {
    label: `${profile.rating_avg.toFixed(1)}`,
    stars: profile.rating_avg,
    isNew: false,
    count: profile.rating_count,
  };
}
