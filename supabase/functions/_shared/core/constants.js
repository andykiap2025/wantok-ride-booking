// GENERATED FILE — DO NOT EDIT.
// Copied from packages/core/src by `npm run sync:core`.
// Edit the original; this copy exists only so Supabase can deploy it.

/**
 * Wantok Ride — shared vocabulary.
 *
 * Every string the rest of the system switches on lives here, so a typo becomes
 * a missing import rather than a comparison that is silently never true.
 * Anything the spec says must be *data* — vehicle classes, rate tables — is
 * deliberately NOT here. That comes from the backend. See `rates.js`.
 */

// --- Booking lifecycle (spec §7) ---------------------------------------
export const BookingState = {
  DRAFT: 'DRAFT',
  REQUESTED: 'REQUESTED',
  CONFIRMED: 'CONFIRMED',
  DECLINED: 'DECLINED',
  EXPIRED: 'EXPIRED',
  DRIVER_EN_ROUTE: 'DRIVER_EN_ROUTE',
  ARRIVED: 'ARRIVED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED_BY_CUSTOMER: 'CANCELLED_BY_CUSTOMER',
  CANCELLED_BY_DRIVER: 'CANCELLED_BY_DRIVER',
  NO_SHOW_CUSTOMER: 'NO_SHOW_CUSTOMER',
  NO_SHOW_DRIVER: 'NO_SHOW_DRIVER',
  DISPUTED: 'DISPUTED',
};

/** States where the booking is over and the vehicle is free again. */
export const TERMINAL_STATES = [
  BookingState.DECLINED,
  BookingState.EXPIRED,
  BookingState.COMPLETED,
  BookingState.CANCELLED_BY_CUSTOMER,
  BookingState.CANCELLED_BY_DRIVER,
  BookingState.NO_SHOW_CUSTOMER,
  BookingState.NO_SHOW_DRIVER,
];

/** States where a trip is live on the admin board and SOS must be on screen. */
export const ACTIVE_STATES = [
  BookingState.CONFIRMED,
  BookingState.DRIVER_EN_ROUTE,
  BookingState.ARRIVED,
  BookingState.IN_PROGRESS,
];

// --- Vehicle status (spec §15) -----------------------------------------
export const VehicleStatus = {
  DRAFT: 'DRAFT',
  PENDING_DOCS: 'PENDING_DOCS',
  PENDING_INSPECTION: 'PENDING_INSPECTION',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  SUSPENDED_UNPAID: 'SUSPENDED_UNPAID',
  SUSPENDED_DOCS: 'SUSPENDED_DOCS',
  SUSPENDED_ADMIN: 'SUSPENDED_ADMIN',
  RETIRED: 'RETIRED',
};

export const Role = {
  CUSTOMER: 'CUSTOMER',
  DRIVER: 'DRIVER',
  OWNER: 'OWNER',
  ADMIN: 'ADMIN',
  SUPER_ADMIN: 'SUPER_ADMIN',
};

// --- Photos (spec §6, step 4) ------------------------------------------
/** Six angles, enforced in the UI. Anything short of these blocks approval. */
export const REQUIRED_PHOTO_ANGLES = [
  'FRONT',
  'REAR',
  'SIDE_LEFT',
  'SIDE_RIGHT',
  'INTERIOR_FRONT',
  'INTERIOR_REAR',
];

export const PHOTO_ANGLE_LABELS = {
  FRONT: 'Front',
  REAR: 'Rear',
  SIDE_LEFT: 'Left side',
  SIDE_RIGHT: 'Right side',
  INTERIOR_FRONT: 'Front interior',
  INTERIOR_REAR: 'Rear interior',
};

// --- Inspection (spec §6) ----------------------------------------------
/**
 * `critical: true` means a FAIL on this item blocks approval outright. The
 * spec names five: brakes, seatbelts, lights, insurance, licence.
 */
export const INSPECTION_ITEMS = [
  { key: 'tyres', label: 'Tyres', critical: false },
  { key: 'brakes', label: 'Brakes', critical: true },
  { key: 'lights', label: 'Lights and indicators', critical: true },
  { key: 'seatbelts', label: 'Seatbelts for every seat', critical: true },
  { key: 'windscreen', label: 'Windscreen', critical: false },
  { key: 'doors', label: 'Doors and locks', critical: false },
  { key: 'interior', label: 'Interior cleanliness', critical: false },
  { key: 'aircon', label: 'Air conditioning', critical: false },
  { key: 'spare', label: 'Spare tyre and jack', critical: false },
  { key: 'odometer', label: 'Odometer reading', critical: false },
  { key: 'bodywork', label: 'Bodywork condition', critical: false },
  { key: 'rego_match', label: 'Registration matches papers', critical: false },
  { key: 'insurance', label: 'Insurance current', critical: true },
  { key: 'licence', label: 'Driver licence current and class-appropriate', critical: true },
];

export const InspectionMark = { PASS: 'PASS', FAIL: 'FAIL', NOTE: 'NOTE' };

export const InspectionResult = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  CONDITIONAL: 'CONDITIONAL',
};

// --- Decline reasons (spec §7 — driver, required) -----------------------
export const DECLINE_REASONS = [
  { code: 'TOO_FAR', label: 'Too far from pickup' },
  { code: 'ROAD_UNSUITABLE', label: 'Destination road not suitable for my vehicle' },
  { code: 'AREA_TIME', label: 'I will not travel to that area at this time' },
  { code: 'VEHICLE_PROBLEM', label: 'Vehicle problem' },
  { code: 'ON_ANOTHER_JOB', label: 'Already on another job' },
  { code: 'OTHER', label: 'Other', requiresText: true },
];

// --- Cancellation reasons ----------------------------------------------
export const CUSTOMER_CANCEL_REASONS = [
  { code: 'CHANGED_PLANS', label: 'My plans changed' },
  { code: 'TOO_LONG', label: 'Driver is taking too long' },
  { code: 'WRONG_DETAILS', label: 'I entered the wrong pickup or destination' },
  { code: 'FOUND_OTHER', label: 'I found another ride' },
  { code: 'OTHER', label: 'Other', requiresText: true },
];

export const DRIVER_CANCEL_REASONS = [
  { code: 'VEHICLE_PROBLEM', label: 'Vehicle problem' },
  { code: 'CANNOT_REACH', label: 'Cannot reach the pickup point' },
  { code: 'PASSENGER_UNREACHABLE', label: 'Passenger is not answering' },
  { code: 'PERSONAL', label: 'Personal emergency' },
  { code: 'OTHER', label: 'Other', requiresText: true },
];

// --- Review tags (spec §9) ----------------------------------------------
export const DRIVER_REVIEW_TAGS = [
  { code: 'CLEAN_VEHICLE', label: 'Clean vehicle', positive: true },
  { code: 'SAFE_DRIVING', label: 'Safe driving', positive: true },
  { code: 'ON_TIME', label: 'On time', positive: true },
  { code: 'POLITE', label: 'Polite', positive: true },
  { code: 'LONG_ROUTE', label: 'Took a long route', positive: false },
  { code: 'NOT_AS_PICTURED', label: 'Vehicle not as pictured', positive: false },
];

export const CUSTOMER_REVIEW_TAGS = [
  { code: 'READY_ON_TIME', label: 'Ready on time', positive: true },
  { code: 'RESPECTFUL', label: 'Respectful', positive: true },
  { code: 'PAID_CORRECT_FARE', label: 'Paid correct fare', positive: true },
  { code: 'KEPT_ME_WAITING', label: 'Kept me waiting', positive: false },
  { code: 'UNDERPAID', label: 'Did not pay full fare', positive: false },
];

// --- Disputes (spec §17) ------------------------------------------------
/** `responseHours: 0` means immediate — safety incidents page the on-call. */
export const DISPUTE_CATEGORIES = [
  { code: 'FARE', label: 'Fare disagreement', responseHours: 24 },
  { code: 'DRIVER_BEHAVIOUR', label: 'Driver behaviour', responseHours: 24 },
  { code: 'CUSTOMER_BEHAVIOUR', label: 'Customer behaviour', responseHours: 24 },
  { code: 'VEHICLE_CONDITION', label: 'Vehicle condition', responseHours: 24 },
  { code: 'NO_SHOW', label: 'No-show', responseHours: 24 },
  { code: 'SAFETY', label: 'Safety incident', responseHours: 0 },
  { code: 'PAYMENT', label: 'Payment not made', responseHours: 24 },
  { code: 'OTHER', label: 'Other', responseHours: 24 },
];

// --- Quick replies (spec §11 — data costs money, cut the typing) --------
export const QUICK_REPLIES = {
  CUSTOMER: [
    'I am outside',
    'I am at the gate',
    'What colour is the vehicle?',
    'Give me 5 minutes',
  ],
  DRIVER: [
    'I am outside',
    '5 minutes away',
    'I am at the gate',
    'Stuck in traffic',
  ],
};

// --- Timings (spec §§7, 10, 13, 16) -------------------------------------
/** One place for every clock in the product. */
export const Timing = {
  /** Immediate booking: the driver has 90 seconds to accept. */
  ACCEPT_WINDOW_SECONDS: 90,
  /** Scheduled booking: the driver has 30 minutes to accept. */
  SCHEDULED_ACCEPT_WINDOW_MINUTES: 30,
  /** Scheduled: minimum lead time. */
  MIN_LEAD_MINUTES: 60,
  /** Scheduled: maximum lead time. */
  MAX_LEAD_DAYS: 14,
  /** Scheduled: the evening-before reminder fires at this local hour. */
  EVENING_REMINDER_HOUR: 18,
  /** Scheduled: second driver reminder, this many minutes before pickup. */
  REMINDER_BEFORE_MINUTES: 60,
  /** Scheduled: released back to the customer if unconfirmed by this point. */
  RELEASE_BEFORE_MINUTES: 45,
  /** Customer reminder, this many minutes before a scheduled pickup. */
  CUSTOMER_REMINDER_BEFORE_MINUTES: 120,
  /** The driver waits this long at pickup before he may mark a no-show. */
  CUSTOMER_NO_SHOW_GRACE_MINUTES: 10,
  /** The customer may mark a driver no-show this long after the agreed time. */
  DRIVER_NO_SHOW_GRACE_MINUTES: 15,
  /** A driver who has not pinged in this long drops off the customer list. */
  PRESENCE_STALE_MINUTES: 10,
  /** Location ping cadence, online and idle. */
  PING_IDLE_SECONDS: 15,
  /** Location ping cadence, on an active trip. */
  PING_ACTIVE_SECONDS: 5,
  /** SOS location streaming cadence and duration. */
  SOS_STREAM_SECONDS: 10,
  SOS_STREAM_MINUTES: 60,
  /** The SOS button must be held this long, to defeat pocket triggers. */
  SOS_HOLD_MS: 3000,
  /** Reviews unblind after this long even if only one side has submitted. */
  REVIEW_BLIND_HOURS: 48,
  /** Chat and exchanged phone numbers close this long after completion. */
  CONTACT_WINDOW_HOURS: 24,
  /** A shared tracking link dies this long after the trip ends. */
  TRIP_SHARE_EXPIRY_HOURS: 2,
  /** No quote may be produced from a rate table older than this. */
  RATE_TABLE_MAX_AGE_HOURS: 24,
  /** Pickup-to-destination route cache, so comparing vehicles is free. */
  ROUTE_CACHE_MINUTES: 10,
  /** No commission for this long after a vehicle is approved. */
  FREE_PERIOD_DAYS: 60,
  /** Document expiry warnings fire at these day counts. */
  DOC_WARNING_DAYS: [30, 14, 7],
  /** OTP sign-in. */
  OTP_LENGTH: 6,
  OTP_EXPIRY_MINUTES: 5,
  OTP_MAX_ATTEMPTS: 3,
  OTP_LOCKOUT_MINUTES: 15,
};

// --- Trust thresholds (spec §7, §9, §8, §13) ----------------------------
export const Thresholds = {
  /** Driver cancels + no-shows in a rolling window that flag an admin review. */
  DRIVER_STRIKES: 3,
  DRIVER_STRIKE_WINDOW_DAYS: 7,
  /** Customer no-shows that block new bookings until they speak to admin. */
  CUSTOMER_NO_SHOWS: 3,
  CUSTOMER_NO_SHOW_WINDOW_DAYS: 30,
  /** A vehicle averaging below this over its last N trips is flagged. */
  VEHICLE_RATING_FLOOR: 3.0,
  VEHICLE_RATING_WINDOW_TRIPS: 20,
  /** Balance at this fraction of its ceiling warns the owner and the driver. */
  BALANCE_WARN_FRACTION: 0.8,
  /** The vehicle list is capped here, so Directions calls stay bounded. */
  MAX_VEHICLES_LISTED: 10,
  /** Google's Port Moresby traffic data is thin. Pad every ETA shown. */
  ETA_PAD_FRACTION: 0.3,
  /** Default commission ceiling, in toea. K100. */
  DEFAULT_CEILING_TOEA: 10000,
};
