/**
 * Test fixtures.
 *
 * The rate table here is the worked example from spec §5 — base K10.00,
 * K3.50/km, K20.00 minimum, ×1.30 at night from 20:00 to 05:00, rounded up to
 * the nearest K5, 10% commission. Keeping the spec's own numbers means a
 * failing test can be checked against the document by hand.
 */

import { normaliseRateVersion } from '../src/rates.js';

export const SEDAN_RATE = normaliseRateVersion({
  id: 'rate-sedan-v1',
  class_code: 'SEDAN',
  base_fare: 10.0,
  per_km: 3.5,
  minimum_fare: 20.0,
  night_multiplier: 1.3,
  night_start: '20:00',
  night_end: '05:00',
  rounding: 5,
  service_fee: 0,
  commission_pct: 10.0,
  effective_from: '2026-01-01T00:00:00Z',
});

export const BUS_RATE = normaliseRateVersion({
  id: 'rate-bus-v1',
  class_code: 'BUS10',
  base_fare: 25.0,
  per_km: 6.0,
  minimum_fare: 60.0,
  night_multiplier: 1.3,
  night_start: '20:00',
  night_end: '05:00',
  rounding: 5,
  service_fee: 0,
  commission_pct: 10.0,
  effective_from: '2026-01-01T00:00:00Z',
});

/**
 * Port Moresby is UTC+10, so local 20:00 is 10:00Z the same day.
 * `pngTime(2026, 9, 10, 20, 0)` reads as "8pm on the 10th, Moresby time".
 */
export function pngTime(year, month, day, hour, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour - 10, minute));
}

/** A midday reference instant used all over the tests. */
export const NOON = pngTime(2026, 9, 10, 12, 0);

export function makeVehicle(overrides = {}) {
  return {
    id: 'veh-1',
    owner_id: 'own-1',
    driver_id: 'drv-1',
    class_code: 'SEDAN',
    make: 'Toyota',
    model: 'Camry',
    year: 2019,
    colour: 'White',
    registration_no: 'BEK-472',
    seats: 4,
    status: 'APPROVED',
    rego_expiry: '2027-06-30',
    insurance_expiry: '2027-03-31',
    rego_doc_url: 'rego.pdf',
    insurance_doc_url: 'ins.pdf',
    approved_at: '2026-01-15T00:00:00Z',
    free_period_ends_at: '2026-03-16T00:00:00Z',
    commission_ceiling: 10000,
    balance_owed: 0,
    seats_note: null,
    ...overrides,
  };
}

export function makeDriver(overrides = {}) {
  return {
    id: 'drv-1',
    profile_id: 'prof-drv-1',
    licence_number: 'PNG-118842',
    licence_class: 'C',
    licence_expiry: '2027-11-30',
    licence_front_url: 'lic-front.jpg',
    licence_back_url: 'lic-back.jpg',
    verified_at: '2026-01-14T00:00:00Z',
    ...overrides,
  };
}

export function makeBooking(overrides = {}) {
  return {
    id: 'bkg-1',
    reference: 'WR-4K7P2M',
    customer_id: 'cust-1',
    vehicle_id: 'veh-1',
    driver_id: 'drv-1',
    state: 'DRAFT',
    is_scheduled: false,
    scheduled_for: null,
    pickup_lat: -9.4438,
    pickup_lng: 147.1803,
    pickup_label: 'Boroko Foodworld',
    dest_lat: -9.4432,
    dest_lng: 147.2196,
    dest_label: 'Jacksons Airport',
    distance_km: 6.0,
    rate_version_id: 'rate-sedan-v1',
    is_night_rate: false,
    quoted_fare: 3500,
    commission_amount: 350,
    created_at: NOON.toISOString(),
    requested_at: null,
    confirmed_at: null,
    en_route_at: null,
    arrived_at: null,
    started_at: null,
    completed_at: null,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    decline_reason: null,
    ...overrides,
  };
}

/** Real NCD coordinates, so distances in the tests are plausible. */
export const PLACES = {
  boroko: { lat: -9.4638, lng: 147.1878 },
  waigani: { lat: -9.4239, lng: 147.1801 },
  airport: { lat: -9.4432, lng: 147.2196 },
  gerehu: { lat: -9.3776, lng: 147.1394 },
  elaBeach: { lat: -9.4795, lng: 147.1543 },
};
