// GENERATED FILE — DO NOT EDIT.
// Copied from packages/core/src by `npm run sync:core`.
// Edit the original; this copy exists only so Supabase can deploy it.

/**
 * SOS (spec §10).
 *
 * The spec is unusually direct here and it is worth repeating in the code:
 *
 *   > An SOS button with nobody on the other end is worse than no button.
 *
 * Nothing in this file is clever. It builds a message, freezes a record, and
 * starts a location stream. The hard part of SOS is the roster and the
 * escalation procedure, which live on paper beside the console — see
 * `docs/sos-escalation.md`. This code exists to make sure that by the time a
 * human picks up the phone, everything they need is already on the screen.
 *
 * Two behaviours that are easy to get wrong and matter enormously:
 *
 *   - An SOS **never cancels the trip**. The trip carries on as far as the app
 *     is concerned.
 *   - The other party is **never told** it was triggered. A passenger who has
 *     pressed SOS because of the driver must not have the driver's phone light
 *     up about it.
 */

import { Timing } from './constants.js';

export const SosRole = { CUSTOMER: 'CUSTOMER', DRIVER: 'DRIVER' };

/**
 * The audit record, frozen at the moment of trigger (spec §10, point 4).
 *
 * Everything is copied in by value. Looking any of it up later would show what
 * is true later — and after an incident, "the vehicle assigned to that booking"
 * may well have been changed, suspended or deleted.
 */
export function buildSosEvent({
  booking,
  vehicle,
  driverProfile,
  customerProfile,
  triggeredBy,
  role,
  location,
  now = new Date(),
}) {
  return {
    booking_id: booking?.id ?? null,
    triggered_by: triggeredBy,
    role,
    lat: location?.lat ?? null,
    lng: location?.lng ?? null,
    triggered_at: now.toISOString(),
    acknowledged_by: null,
    acknowledged_at: null,
    resolution: null,
    notes: null,

    // Frozen snapshot. Never re-resolved from live rows.
    snapshot: {
      reference: booking?.reference ?? null,
      state: booking?.state ?? null,
      pickup: booking ? { label: booking.pickup_label, lat: booking.pickup_lat, lng: booking.pickup_lng } : null,
      destination: booking ? { label: booking.dest_label, lat: booking.dest_lat, lng: booking.dest_lng } : null,
      quoted_fare: booking?.quoted_fare ?? null,
      vehicle: vehicle
        ? {
            registration_no: vehicle.registration_no,
            make: vehicle.make,
            model: vehicle.model,
            colour: vehicle.colour,
            class_code: vehicle.class_code,
          }
        : null,
      driver: driverProfile
        ? {
            id: driverProfile.id,
            full_name: driverProfile.full_name,
            phone: driverProfile.phone,
            emergency_contact_name: driverProfile.emergency_contact_name,
            emergency_contact_phone: driverProfile.emergency_contact_phone,
          }
        : null,
      customer: customerProfile
        ? {
            id: customerProfile.id,
            full_name: customerProfile.full_name,
            phone: customerProfile.phone,
            emergency_contact_name: customerProfile.emergency_contact_name,
            emergency_contact_phone: customerProfile.emergency_contact_phone,
          }
        : null,
    },
  };
}

/**
 * The SMS to the emergency contact (spec §10, point 2).
 *
 * Plain SMS, because the contact does not have the app and may not have data.
 * Kept inside one 160-character segment where it can be, because it will be
 * read on a feature phone and because segments cost money.
 */
export function emergencyContactSms(event, { trackingUrl } = {}) {
  const s = event.snapshot;
  const who = event.role === SosRole.CUSTOMER ? s.customer : s.driver;
  const name = who?.full_name ?? 'A Wantok Ride user';
  const vehicle = s.vehicle
    ? `${s.vehicle.colour} ${s.vehicle.make} ${s.vehicle.model}, rego ${s.vehicle.registration_no}`
    : 'vehicle unknown';
  const driver = s.driver ? `${s.driver.full_name} ${s.driver.phone}` : 'driver unknown';

  return [
    `WANTOK RIDE ALERT: ${name} has raised an emergency alert.`,
    `Booking ${s.reference ?? 'n/a'}.`,
    `Vehicle: ${vehicle}.`,
    `Driver: ${driver}.`,
    trackingUrl ? `Live location: ${trackingUrl}` : null,
    'Wantok Ride is contacting them now.',
  ]
    .filter(Boolean)
    .join(' ');
}

/** The alert the admin console alarms on. Cannot be dismissed unacknowledged. */
export function adminAlert(event) {
  const s = event.snapshot;
  return {
    severity: 'CRITICAL',
    title: `SOS — ${event.role === SosRole.CUSTOMER ? 'Passenger' : 'Driver'}`,
    reference: s.reference,
    vehicle: s.vehicle?.registration_no ?? null,
    location: { lat: event.lat, lng: event.lng },
    triggeredAt: event.triggered_at,
    requiresAcknowledgement: true,
    contacts: [
      s.customer && { role: 'Passenger', name: s.customer.full_name, phone: s.customer.phone },
      s.driver && { role: 'Driver', name: s.driver.full_name, phone: s.driver.phone },
      s.customer?.emergency_contact_phone && {
        role: 'Passenger emergency contact',
        name: s.customer.emergency_contact_name,
        phone: s.customer.emergency_contact_phone,
      },
      s.driver?.emergency_contact_phone && {
        role: 'Driver emergency contact',
        name: s.driver.emergency_contact_name,
        phone: s.driver.emergency_contact_phone,
      },
    ].filter(Boolean),
  };
}

/** The location stream that follows a trigger: every 10s for 60 minutes. */
export function streamPlan(triggeredAt) {
  const start = new Date(triggeredAt);
  return {
    everySeconds: Timing.SOS_STREAM_SECONDS,
    until: new Date(start.getTime() + Timing.SOS_STREAM_MINUTES * 60_000),
    /** Runs regardless of app state — backgrounded, locked or killed. */
    background: true,
  };
}

export function isStreaming(event, now = new Date()) {
  return now.getTime() < streamPlan(event.triggered_at).until.getTime();
}

/**
 * Acknowledge an alert. A note is mandatory (spec §10, point 1) — the alarm
 * cannot be silenced by clicking through it, which is exactly what happens to
 * every alarm that can be.
 */
export function acknowledge(event, { adminId, note, now = new Date() }) {
  if (!note?.trim()) {
    return { ok: false, error: 'A note is required to acknowledge an SOS' };
  }
  return {
    ok: true,
    event: {
      ...event,
      acknowledged_by: adminId,
      acknowledged_at: now.toISOString(),
      notes: note.trim(),
    },
  };
}

/** Seconds an alert has been sounding. The console escalates on 120. */
export function secondsUnacknowledged(event, now = new Date()) {
  if (event.acknowledged_at) return 0;
  return Math.floor((now.getTime() - new Date(event.triggered_at).getTime()) / 1000);
}

/**
 * Trip sharing (spec §10).
 *
 * A plain web page — no app, no login — because the person receiving it is a
 * mother in Gerehu with a K30 handset, not a user. It dies two hours after the
 * trip ends so an old link cannot be used to follow someone around.
 */
export function tripShareLink({ booking, token, baseUrl = 'https://track.wantokride.com' }) {
  return `${baseUrl}/t/${token}`;
}

export function tripShareExpiry(booking) {
  const ended = booking.completed_at ?? booking.cancelled_at;
  if (!ended) return null;
  return new Date(new Date(ended).getTime() + Timing.TRIP_SHARE_EXPIRY_HOURS * 3_600_000);
}

export function isTripShareValid(booking, now = new Date()) {
  const expiry = tripShareExpiry(booking);
  if (!expiry) return true; // trip still running
  return now.getTime() < expiry.getTime();
}
