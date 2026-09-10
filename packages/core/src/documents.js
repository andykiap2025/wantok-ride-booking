/**
 * Documents, inspection and the approval gate (spec §6).
 *
 * Spec §6 opens by saying registration is deliberately slow and manual, and
 * that this is the platform's main trust asset. Everything here exists to stop
 * that asset being automated away by a well-meaning shortcut later.
 *
 * The hardest rule in the file is the automatic one: **a vehicle whose
 * insurance expires is suspended on the expiry date, without an admin
 * deciding.** An expired-insurance vehicle carrying a paying passenger is the
 * single largest liability the platform has, and it is not a judgement call.
 */

import {
  INSPECTION_ITEMS,
  InspectionMark,
  InspectionResult,
  REQUIRED_PHOTO_ANGLES,
  Timing,
  VehicleStatus,
} from './constants.js';

export const DocState = { CURRENT: 'CURRENT', WARNING: 'WARNING', EXPIRED: 'EXPIRED', MISSING: 'MISSING' };

/**
 * Warning thresholds, smallest first.
 *
 * The order matters. `DOC_WARNING_DAYS` reads naturally as [30, 14, 7], but
 * "which band is this document in" wants the *tightest* threshold that still
 * covers it — a certificate with 7 days left is in the 7-day band, not the
 * 30-day one. Searching the descending list would answer 30 every time.
 */
const WARNING_BANDS = [...Timing.DOC_WARNING_DAYS].sort((a, b) => a - b);

function warningBandFor(daysLeft) {
  return WARNING_BANDS.find((d) => daysLeft <= d) ?? null;
}

/** Whole days from `now` until `expiry`. Negative once it has passed. */
export function daysUntil(expiry, now = new Date()) {
  if (!expiry) return null;
  const end = new Date(expiry);
  // Compare at day granularity: a document expiring "today" has 0 days left
  // all day, not 0.4 of a day at lunchtime.
  const a = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  const b = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((a - b) / 86_400_000);
}

/**
 * Where a single document stands.
 *
 * Expiry is inclusive of the day itself — a certificate expiring on the 30th
 * is valid all of the 30th and dead on the 31st.
 */
export function documentStatus(expiry, now = new Date()) {
  if (!expiry) return { state: DocState.MISSING, daysLeft: null };
  const daysLeft = daysUntil(expiry, now);
  if (daysLeft < 0) return { state: DocState.EXPIRED, daysLeft };
  const warnAt = warningBandFor(daysLeft);
  return {
    state: warnAt === null ? DocState.CURRENT : DocState.WARNING,
    daysLeft,
    warnAt,
  };
}

/** Every expiring document attached to a vehicle, in one list. */
export function vehicleDocuments(vehicle, driver, now = new Date()) {
  const docs = [
    { kind: 'REGO', label: 'Registration', expiry: vehicle.rego_expiry, url: vehicle.rego_doc_url },
    { kind: 'INSURANCE', label: 'Insurance', expiry: vehicle.insurance_expiry, url: vehicle.insurance_doc_url },
  ];
  if (driver) {
    docs.push({
      kind: 'LICENCE',
      label: 'Driver licence',
      expiry: driver.licence_expiry,
      url: driver.licence_front_url,
    });
  }
  return docs.map((d) => ({ ...d, ...documentStatus(d.expiry, now) }));
}

/**
 * Which warning notifications are due today (spec §6, expiry tracking).
 *
 * Returns the exact threshold crossed so the sender can be idempotent — a
 * nightly job that runs twice must not send the 14-day warning twice.
 */
export function dueWarnings(vehicle, driver, now = new Date(), alreadySent = []) {
  const sent = new Set(alreadySent.map((w) => `${w.kind}:${w.threshold}`));
  const out = [];
  for (const doc of vehicleDocuments(vehicle, driver, now)) {
    if (doc.state !== DocState.WARNING) continue;
    const threshold = warningBandFor(doc.daysLeft);
    if (threshold === null) continue;
    if (sent.has(`${doc.kind}:${threshold}`)) continue;
    out.push({ kind: doc.kind, label: doc.label, threshold, daysLeft: doc.daysLeft, expiry: doc.expiry });
  }
  return out;
}

/**
 * Should this vehicle come off the road right now?
 *
 * Not optional, not a warning, not queued for admin. Any expired document and
 * the vehicle is suspended.
 */
export function docSuspension(vehicle, driver, now = new Date()) {
  const expired = vehicleDocuments(vehicle, driver, now).filter(
    (d) => d.state === DocState.EXPIRED || d.state === DocState.MISSING,
  );
  return {
    shouldSuspend: expired.length > 0 && vehicle.status === VehicleStatus.APPROVED,
    expired,
    reason: expired.map((d) => d.label).join(', '),
  };
}

// --- Photos -------------------------------------------------------------

/**
 * Which of the six required angles are still missing (spec §6, step 4).
 *
 * The UI enforces the count *and the angles* — six photos of the front is not
 * six photos. That is why this checks the set, not the length.
 */
export function missingPhotoAngles(photos = []) {
  const have = new Set(photos.map((p) => p.angle));
  return REQUIRED_PHOTO_ANGLES.filter((angle) => !have.has(angle));
}

export function photosComplete(photos) {
  return missingPhotoAngles(photos).length === 0;
}

// --- Inspection ---------------------------------------------------------

/**
 * Turn a filled checklist into a result.
 *
 * A failed critical item — brakes, seatbelts, lights, insurance, licence —
 * blocks approval outright and cannot be waived from this function. An admin
 * who wants to override does it deliberately, in the console, in the audit log.
 */
export function evaluateInspection(checklist = {}) {
  const critical = [];
  const failures = [];
  const missing = [];

  for (const item of INSPECTION_ITEMS) {
    const mark = checklist[item.key]?.mark ?? checklist[item.key];
    if (!mark) {
      missing.push(item);
      continue;
    }
    if (mark === InspectionMark.FAIL) {
      failures.push(item);
      if (item.critical) critical.push(item);
    }
  }

  let result;
  if (missing.length) result = null; // incomplete — not a verdict yet
  else if (critical.length) result = InspectionResult.FAIL;
  else if (failures.length) result = InspectionResult.CONDITIONAL;
  else result = InspectionResult.PASS;

  return {
    result,
    complete: missing.length === 0,
    missing,
    failures,
    criticalFailures: critical,
    blocksApproval: critical.length > 0,
  };
}

// --- The approval gate --------------------------------------------------

/**
 * The single check standing between a vehicle and paying passengers
 * (spec §15, key integrity rules).
 *
 * A vehicle cannot reach APPROVED without a passing inspection, six photos,
 * and unexpired rego, insurance and licence. This returns every blocker at
 * once rather than the first, so an admin fixes the file in one pass instead
 * of discovering problems one rejection at a time.
 */
export function approvalBlockers({ vehicle, photos = [], inspection, driver, now = new Date() }) {
  const blockers = [];

  const missingAngles = missingPhotoAngles(photos);
  if (missingAngles.length) {
    blockers.push({
      code: 'PHOTOS',
      message: `Missing ${missingAngles.length} of 6 photos`,
      detail: missingAngles,
    });
  }

  if (!inspection) {
    blockers.push({ code: 'NO_INSPECTION', message: 'No physical inspection recorded' });
  } else {
    const verdict = evaluateInspection(inspection.checklist);
    if (!verdict.complete) {
      blockers.push({
        code: 'INSPECTION_INCOMPLETE',
        message: `${verdict.missing.length} checklist items not marked`,
        detail: verdict.missing.map((i) => i.label),
      });
    } else if (verdict.blocksApproval) {
      blockers.push({
        code: 'INSPECTION_CRITICAL_FAIL',
        message: 'Critical inspection failure',
        detail: verdict.criticalFailures.map((i) => i.label),
      });
    }
  }

  for (const doc of vehicleDocuments(vehicle, driver, now)) {
    if (doc.state === DocState.MISSING) {
      blockers.push({ code: `${doc.kind}_MISSING`, message: `${doc.label} not supplied` });
    } else if (doc.state === DocState.EXPIRED) {
      blockers.push({
        code: `${doc.kind}_EXPIRED`,
        message: `${doc.label} expired ${Math.abs(doc.daysLeft)} days ago`,
      });
    }
  }

  if (!driver) {
    blockers.push({ code: 'NO_DRIVER', message: 'No driver assigned to this vehicle' });
  }

  return blockers;
}

export function canApprove(args) {
  const blockers = approvalBlockers(args);
  return { ok: blockers.length === 0, blockers };
}

/**
 * Where the owner is in onboarding, for the progress strip in the app.
 *
 * Seven steps, matching spec §6 one for one. Owners abandon what they cannot
 * see the end of.
 */
export function onboardingProgress({ vehicle, photos = [], inspection, owner }) {
  const steps = [
    { key: 'ACCOUNT', label: 'Owner account', done: Boolean(owner?.nid_number && owner?.bank_account) },
    { key: 'VEHICLE', label: 'Vehicle details', done: Boolean(vehicle?.registration_no && vehicle?.class_code) },
    {
      key: 'DOCUMENTS',
      label: 'Documents uploaded',
      done: Boolean(vehicle?.rego_doc_url && vehicle?.insurance_doc_url),
    },
    { key: 'PHOTOS', label: 'Six photos', done: photosComplete(photos) },
    { key: 'INSPECTION', label: 'Physical inspection', done: Boolean(inspection?.inspected_at) },
    {
      key: 'DECISION',
      label: 'Admin decision',
      done: [VehicleStatus.APPROVED, VehicleStatus.REJECTED].includes(vehicle?.status),
    },
    { key: 'LIVE', label: 'Live on the app', done: vehicle?.status === VehicleStatus.APPROVED },
  ];
  const done = steps.filter((s) => s.done).length;
  return { steps, done, total: steps.length, current: steps.find((s) => !s.done) ?? null };
}
