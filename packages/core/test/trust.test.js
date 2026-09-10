/**
 * Trust rules: reviews, conduct records, documents and the approval gate
 * (spec §6, §7, §9).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregate,
  canReview,
  customerBadge,
  hideReview,
  isUnblinded,
  validateReview,
  vehicleNeedsReview,
  visibleReviews,
  SubjectType,
} from '../src/reviews.js';
import {
  StrikeType,
  canBook,
  customerBookingBlock,
  driverReviewFlag,
  strikeFor,
} from '../src/conduct.js';
import {
  DocState,
  approvalBlockers,
  canApprove,
  daysUntil,
  docSuspension,
  documentStatus,
  dueWarnings,
  evaluateInspection,
  missingPhotoAngles,
  onboardingProgress,
  photosComplete,
} from '../src/documents.js';
import { BookingState, InspectionMark, InspectionResult, REQUIRED_PHOTO_ANGLES, VehicleStatus } from '../src/constants.js';
import { makeBooking, makeDriver, makeVehicle } from './fixtures.js';

const iso = (s) => new Date(s).toISOString();
const NOW = new Date('2026-09-10T00:00:00Z');

// =========================================================================
// Reviews
// =========================================================================

test('only a completed trip can be reviewed', () => {
  for (const state of [BookingState.CANCELLED_BY_CUSTOMER, BookingState.NO_SHOW_CUSTOMER, BookingState.IN_PROGRESS]) {
    const verdict = canReview({ booking: makeBooking({ state }), authorId: 'cust-1' });
    assert.equal(verdict.ok, false, state);
  }
  assert.equal(canReview({ booking: makeBooking({ state: BookingState.COMPLETED }), authorId: 'cust-1' }).ok, true);
});

test('a customer reviews the vehicle and a driver reviews the customer', () => {
  const booking = makeBooking({ state: BookingState.COMPLETED });
  assert.equal(canReview({ booking, authorId: 'cust-1' }).subjectType, SubjectType.VEHICLE);
  assert.equal(canReview({ booking, authorId: 'drv-1' }).subjectType, SubjectType.CUSTOMER);
});

test('someone who was not on the trip cannot review it', () => {
  const booking = makeBooking({ state: BookingState.COMPLETED });
  assert.equal(canReview({ booking, authorId: 'stranger' }).ok, false);
});

test('one review per booking per side', () => {
  const booking = makeBooking({ state: BookingState.COMPLETED });
  const existing = [{ booking_id: 'bkg-1', author_id: 'cust-1' }];
  assert.equal(canReview({ booking, authorId: 'cust-1', existingReviews: existing }).ok, false);
  assert.equal(canReview({ booking, authorId: 'drv-1', existingReviews: existing }).ok, true);
});

test('a review must be 1 to 5 whole stars', () => {
  for (const stars of [0, 6, 3.5, -1, null]) {
    assert.equal(validateReview({ stars, subjectType: SubjectType.VEHICLE }).ok, false, String(stars));
  }
  assert.equal(validateReview({ stars: 4, subjectType: SubjectType.VEHICLE }).ok, true);
});

test('tags are checked against the vocabulary for that side', () => {
  assert.equal(
    validateReview({ stars: 5, tags: ['CLEAN_VEHICLE'], subjectType: SubjectType.VEHICLE }).ok,
    true,
  );
  // "Clean vehicle" is not something a driver can say about a passenger.
  assert.equal(
    validateReview({ stars: 5, tags: ['CLEAN_VEHICLE'], subjectType: SubjectType.CUSTOMER }).ok,
    false,
  );
});

test('reviews stay blind until both sides have submitted', () => {
  const booking = makeBooking({ state: BookingState.COMPLETED, completed_at: iso('2026-09-10T00:00:00Z') });
  const oneSide = [{ booking_id: 'bkg-1', author_id: 'cust-1', stars: 2 }];
  assert.equal(isUnblinded({ booking, reviews: oneSide, now: new Date('2026-09-10T06:00:00Z') }), false);

  const bothSides = [...oneSide, { booking_id: 'bkg-1', author_id: 'drv-1', stars: 5 }];
  assert.equal(isUnblinded({ booking, reviews: bothSides, now: new Date('2026-09-10T06:00:00Z') }), true);
});

test('reviews unblind after 48 hours even if only one side submitted', () => {
  const booking = makeBooking({ state: BookingState.COMPLETED, completed_at: iso('2026-09-10T00:00:00Z') });
  const oneSide = [{ booking_id: 'bkg-1', author_id: 'cust-1', stars: 2 }];
  assert.equal(isUnblinded({ booking, reviews: oneSide, now: new Date('2026-09-11T23:59:00Z') }), false);
  assert.equal(isUnblinded({ booking, reviews: oneSide, now: new Date('2026-09-12T00:00:00Z') }), true);
});

test('you can always see the review you wrote yourself', () => {
  const booking = makeBooking({ state: BookingState.COMPLETED, completed_at: iso('2026-09-10T00:00:00Z') });
  const reviews = [{ booking_id: 'bkg-1', author_id: 'cust-1', stars: 2 }];
  const seen = visibleReviews({
    reviews,
    bookings: [booking],
    viewerId: 'cust-1',
    now: new Date('2026-09-10T01:00:00Z'),
  });
  assert.equal(seen.length, 1);

  const seenByOther = visibleReviews({
    reviews,
    bookings: [booking],
    viewerId: 'drv-1',
    now: new Date('2026-09-10T01:00:00Z'),
  });
  assert.equal(seenByOther.length, 0);
});

test('a hidden review is excluded from the average and the rating recalculates', () => {
  const reviews = [
    { stars: 5, visible: true },
    { stars: 5, visible: true },
    { stars: 1, visible: true },
  ];
  assert.equal(aggregate(reviews).stars, 3.7);

  const hidden = [reviews[0], reviews[1], hideReview(reviews[2], { adminId: 'adm-1', reason: 'Abusive' })];
  assert.equal(aggregate(hidden).stars, 5);
  assert.equal(hidden[2].hidden_by, 'adm-1');
  assert.equal(hidden[2].visible, false);
});

test('a vehicle below 3.0 over its last 20 trips is flagged', () => {
  const bad = Array.from({ length: 20 }, (_, i) => ({
    stars: 2,
    visible: true,
    created_at: iso(`2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z`),
  }));
  assert.equal(vehicleNeedsReview(bad).flagged, true);
});

test('the flag uses a window, so a long history of good trips does not hide a bad month', () => {
  const good = Array.from({ length: 100 }, (_, i) => ({
    stars: 5,
    visible: true,
    created_at: iso(`2026-0${1 + (i % 6)}-01T00:00:00Z`),
  }));
  const recentBad = Array.from({ length: 20 }, (_, i) => ({
    stars: 1,
    visible: true,
    created_at: iso(`2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z`),
  }));
  assert.equal(vehicleNeedsReview([...good, ...recentBad]).flagged, true);
});

test('a vehicle with only a handful of trips is not flagged on one bad morning', () => {
  const few = [
    { stars: 1, visible: true, created_at: iso('2026-09-01T00:00:00Z') },
    { stars: 2, visible: true, created_at: iso('2026-09-02T00:00:00Z') },
  ];
  assert.equal(vehicleNeedsReview(few).flagged, false);
});

test('a new passenger reads as new, not as zero stars', () => {
  assert.deepEqual(customerBadge({ rating_count: 0 }), { label: 'New passenger', stars: null, isNew: true });
  assert.equal(customerBadge({ rating_count: 12, rating_avg: 4.6 }).label, '4.6');
});

// =========================================================================
// Conduct
// =========================================================================

test('a cancellation before the driver accepted leaves no mark', () => {
  assert.equal(strikeFor(makeBooking({ state: BookingState.CANCELLED_BY_CUSTOMER, confirmed_at: null })), null);
});

test('a cancellation after the driver set off counts double', () => {
  const strike = strikeFor(
    makeBooking({
      state: BookingState.CANCELLED_BY_CUSTOMER,
      confirmed_at: iso('2026-09-10T00:00:00Z'),
      en_route_at: iso('2026-09-10T00:02:00Z'),
    }),
  );
  assert.equal(strike.weight, 2);
  assert.equal(strike.against, 'CUSTOMER');
});

test('an unanswered 90-second request is not a strike, but a dropped scheduled booking is', () => {
  assert.equal(strikeFor(makeBooking({ state: BookingState.EXPIRED })), null);
  const released = strikeFor(
    makeBooking({ state: BookingState.EXPIRED, released_at: iso('2026-09-10T06:15:00Z') }),
  );
  assert.equal(released.type, StrikeType.DRIVER_NO_SHOW);
  assert.equal(released.against, 'VEHICLE');
});

test('three driver strikes in a rolling 7 days flags the vehicle for review', () => {
  const records = [
    { type: StrikeType.DRIVER_CANCEL, weight: 1, created_at: iso('2026-09-05T00:00:00Z') },
    { type: StrikeType.DRIVER_NO_SHOW, weight: 1, created_at: iso('2026-09-07T00:00:00Z') },
    { type: StrikeType.DRIVER_CANCEL, weight: 1, created_at: iso('2026-09-09T00:00:00Z') },
  ];
  assert.equal(driverReviewFlag(records, NOW).flagged, true);
});

test('driver strikes fall out of the window as it rolls', () => {
  const records = [
    { type: StrikeType.DRIVER_CANCEL, weight: 1, created_at: iso('2026-08-20T00:00:00Z') },
    { type: StrikeType.DRIVER_CANCEL, weight: 1, created_at: iso('2026-09-08T00:00:00Z') },
    { type: StrikeType.DRIVER_CANCEL, weight: 1, created_at: iso('2026-09-09T00:00:00Z') },
  ];
  const flag = driverReviewFlag(records, NOW);
  assert.equal(flag.count, 2);
  assert.equal(flag.flagged, false);
});

test('three customer no-shows in 30 days blocks new bookings with an explanation', () => {
  const records = Array.from({ length: 3 }, (_, i) => ({
    type: StrikeType.CUSTOMER_NO_SHOW,
    weight: 1,
    created_at: iso(`2026-09-0${i + 1}T00:00:00Z`),
  }));
  const block = customerBookingBlock(records, NOW);
  assert.equal(block.blocked, true);
  assert.match(block.message, /support/i);
});

test('booking is refused until an emergency contact is verified', () => {
  const unverified = { status: 'ACTIVE', emergency_verified_at: null };
  assert.equal(canBook({ profile: unverified, records: [] }).code, 'EMERGENCY_CONTACT');

  const verified = { status: 'ACTIVE', emergency_verified_at: iso('2026-09-01T00:00:00Z') };
  assert.equal(canBook({ profile: verified, records: [] }).ok, true);
});

// =========================================================================
// Documents
// =========================================================================

test('expiry is counted in whole days and includes the expiry day itself', () => {
  assert.equal(daysUntil('2026-09-10', NOW), 0);
  assert.equal(daysUntil('2026-09-11', NOW), 1);
  assert.equal(daysUntil('2026-09-09', NOW), -1);
  assert.equal(documentStatus('2026-09-10', NOW).state, DocState.WARNING);
  assert.equal(documentStatus('2026-09-09', NOW).state, DocState.EXPIRED);
});

test('warnings fire at 30, 14 and 7 days', () => {
  assert.equal(documentStatus('2026-10-11', NOW).state, DocState.CURRENT); // 31 days
  assert.equal(documentStatus('2026-10-10', NOW).warnAt, 30);
  assert.equal(documentStatus('2026-09-24', NOW).warnAt, 14);
  assert.equal(documentStatus('2026-09-17', NOW).warnAt, 7);
});

test('a warning already sent is not sent again by the next nightly run', () => {
  const vehicle = makeVehicle({ insurance_expiry: '2026-09-17', rego_expiry: '2030-01-01' });
  const driver = makeDriver({ licence_expiry: '2030-01-01' });
  const first = dueWarnings(vehicle, driver, NOW, []);
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, 'INSURANCE');
  assert.equal(first[0].threshold, 7);

  const second = dueWarnings(vehicle, driver, NOW, [{ kind: 'INSURANCE', threshold: 7 }]);
  assert.equal(second.length, 0);
});

test('an expired document suspends the vehicle automatically', () => {
  const vehicle = makeVehicle({ insurance_expiry: '2026-09-09', status: VehicleStatus.APPROVED });
  const suspension = docSuspension(vehicle, makeDriver(), NOW);
  assert.equal(suspension.shouldSuspend, true);
  assert.match(suspension.reason, /Insurance/);
});

test('an expired driver licence suspends the vehicle too', () => {
  const suspension = docSuspension(makeVehicle(), makeDriver({ licence_expiry: '2026-01-01' }), NOW);
  assert.equal(suspension.shouldSuspend, true);
  assert.match(suspension.reason, /licence/i);
});

// --- Photos --------------------------------------------------------------

test('six photos means six angles, not six files', () => {
  const sixOfTheFront = Array.from({ length: 6 }, () => ({ angle: 'FRONT' }));
  assert.equal(photosComplete(sixOfTheFront), false);
  assert.equal(missingPhotoAngles(sixOfTheFront).length, 5);

  const proper = REQUIRED_PHOTO_ANGLES.map((angle) => ({ angle }));
  assert.equal(photosComplete(proper), true);
});

// --- Inspection ----------------------------------------------------------

const passAll = () =>
  Object.fromEntries(
    [
      'tyres', 'brakes', 'lights', 'seatbelts', 'windscreen', 'doors', 'interior',
      'aircon', 'spare', 'odometer', 'bodywork', 'rego_match', 'insurance', 'licence',
    ].map((k) => [k, { mark: InspectionMark.PASS }]),
  );

test('a clean checklist passes', () => {
  const verdict = evaluateInspection(passAll());
  assert.equal(verdict.result, InspectionResult.PASS);
  assert.equal(verdict.blocksApproval, false);
});

test('a failed critical item blocks approval outright', () => {
  for (const key of ['brakes', 'seatbelts', 'lights', 'insurance', 'licence']) {
    const checklist = { ...passAll(), [key]: { mark: InspectionMark.FAIL } };
    const verdict = evaluateInspection(checklist);
    assert.equal(verdict.result, InspectionResult.FAIL, key);
    assert.equal(verdict.blocksApproval, true, key);
  }
});

test('a failed non-critical item is a conditional pass, not a rejection', () => {
  const verdict = evaluateInspection({ ...passAll(), aircon: { mark: InspectionMark.FAIL } });
  assert.equal(verdict.result, InspectionResult.CONDITIONAL);
  assert.equal(verdict.blocksApproval, false);
});

test('an unfinished checklist is not a verdict', () => {
  const partial = { ...passAll() };
  delete partial.spare;
  const verdict = evaluateInspection(partial);
  assert.equal(verdict.complete, false);
  assert.equal(verdict.result, null);
});

// --- The approval gate ---------------------------------------------------

const goodInspection = () => ({ inspected_at: iso('2026-09-01T00:00:00Z'), checklist: passAll() });
const sixPhotos = () => REQUIRED_PHOTO_ANGLES.map((angle) => ({ angle, url: `${angle}.jpg` }));

test('a complete file approves', () => {
  const verdict = canApprove({
    vehicle: makeVehicle(),
    photos: sixPhotos(),
    inspection: goodInspection(),
    driver: makeDriver(),
    now: NOW,
  });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.blockers, []);
});

test('approval is blocked without an inspection', () => {
  const blockers = approvalBlockers({
    vehicle: makeVehicle(),
    photos: sixPhotos(),
    inspection: null,
    driver: makeDriver(),
    now: NOW,
  });
  assert.ok(blockers.some((b) => b.code === 'NO_INSPECTION'));
});

test('approval is blocked with expired insurance, however good the inspection', () => {
  const blockers = approvalBlockers({
    vehicle: makeVehicle({ insurance_expiry: '2026-01-01' }),
    photos: sixPhotos(),
    inspection: goodInspection(),
    driver: makeDriver(),
    now: NOW,
  });
  assert.ok(blockers.some((b) => b.code === 'INSURANCE_EXPIRED'));
});

test('every blocker is reported at once, not one rejection at a time', () => {
  const blockers = approvalBlockers({
    vehicle: makeVehicle({ insurance_expiry: '2026-01-01', rego_expiry: '2026-01-01' }),
    photos: [{ angle: 'FRONT' }],
    inspection: null,
    driver: null,
    now: NOW,
  });
  const codes = blockers.map((b) => b.code);
  assert.ok(codes.includes('PHOTOS'));
  assert.ok(codes.includes('NO_INSPECTION'));
  assert.ok(codes.includes('INSURANCE_EXPIRED'));
  assert.ok(codes.includes('REGO_EXPIRED'));
  assert.ok(codes.includes('NO_DRIVER'));
});

test('onboarding progress tracks the seven steps of spec §6', () => {
  const progress = onboardingProgress({
    vehicle: makeVehicle({ status: VehicleStatus.PENDING_INSPECTION }),
    photos: sixPhotos(),
    inspection: null,
    owner: { nid_number: 'NID-1', bank_account: '1001' },
  });
  assert.equal(progress.total, 7);
  assert.equal(progress.done, 4);
  assert.equal(progress.current.key, 'INSPECTION');
});
