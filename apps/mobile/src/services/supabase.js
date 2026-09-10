/**
 * The Supabase adapter.
 *
 * This is the production data layer. Every query here targets the schema in
 * `supabase/migrations/` — table names, column names and the two views are all
 * as defined there, so a change on one side should break the other loudly.
 *
 * What deliberately is *not* here: any rule. The fare is not computed in this
 * file, and neither is "may this booking be cancelled". Those live in
 * `@wantok/core` and run identically on the handset, in an edge function and
 * in a unit test. This file moves rows.
 *
 * Three things the database does that this file therefore does not have to:
 *
 *   - `vehicles.balance_owed` is maintained by trigger from `ledger_entries`.
 *     Nothing here ever writes it.
 *   - The 48-hour review blind window and the contact-details window are RLS
 *     policies and a view. A client that forgot them would still be refused.
 *   - Commission is posted by the `booking_on_complete` trigger when a booking
 *     reaches COMPLETED. The app does not post it.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import {
  Timing,
  availableVehicles,
  haversineKm,
  makeReference,
  normaliseRateVersion,
  quote,
  resolveRateVersion,
} from '@wantok/core';

import { SUPABASE_ANON_KEY, SUPABASE_URL } from './config';

// ---------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    // React Native has no localStorage, and a driver signed out every time
    // Android reclaims the process would be unusable. AsyncStorage keeps the
    // session across restarts; `detectSessionInUrl` is a browser concern and
    // throws here if left on.
    storage: AsyncStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
  global: {
    headers: { 'x-wantok-client': 'mobile' },
  },
});

function unwrap({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

// ---------------------------------------------------------------------
// Auth (spec §16 — phone OTP, no passwords, for every role)
// ---------------------------------------------------------------------

export async function requestOtp(phone) {
  return unwrap(await supabase.auth.signInWithOtp({ phone }));
}

export async function verifyOtp(phone, token) {
  // Six digits, five-minute expiry and the three-attempt lockout are all
  // configured on the Supabase Auth project, not here — a client that could
  // decide its own attempt count has no lockout.
  return unwrap(await supabase.auth.verifyOtp({ phone, token, type: 'sms' }));
}

export async function signOut() {
  return unwrap(await supabase.auth.signOut());
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

// ---------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------

export async function getProfile(id) {
  return unwrap(await supabase.from('profiles').select('*').eq('id', id).single());
}

export async function updateProfile(id, patch) {
  return unwrap(await supabase.from('profiles').update(patch).eq('id', id).select().single());
}

/**
 * Emergency contact (spec §10).
 *
 * `emergency_verified_at` is set by the edge function that receives the reply
 * to the test SMS — never by the app. An account can claim a contact; only a
 * number that answered can be verified.
 */
export async function requestEmergencyContactVerification({ name, phone }) {
  return unwrap(
    await supabase.functions.invoke('verify-emergency-contact', { body: { name, phone } }),
  );
}

// ---------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------

/**
 * An account carries both roles rather than needing two logins (spec §3).
 *
 * These return null rather than throwing when the row does not exist, because
 * "this customer is not a driver" is the common case, not an error. `.single()`
 * errors on no rows, so `.maybeSingle()` is the right call here.
 */
export async function getDriverForProfile(profileId) {
  const { data, error } = await supabase
    .from('drivers')
    .select('*')
    .eq('profile_id', profileId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function getOwnerForProfile(profileId) {
  const { data, error } = await supabase
    .from('owners')
    .select('*')
    .eq('profile_id', profileId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/** The vehicle this driver is assigned to. One driver, one vehicle (spec §3). */
export async function getVehicleForDriver(driverId) {
  const { data, error } = await supabase
    .from('vehicles')
    .select('*')
    .eq('driver_id', driverId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function getVehiclesForOwner(ownerId) {
  return unwrap(
    await supabase.from('vehicles').select('*').eq('owner_id', ownerId).order('created_at'),
  );
}

/** Conduct records, so a customer can see why they have been blocked. */
export async function getConductRecords(subjectType, subjectId) {
  return unwrap(
    await supabase
      .from('conduct_records')
      .select('*')
      .eq('subject_type', subjectType)
      .eq('subject_id', subjectId)
      .order('created_at', { ascending: false }),
  );
}

// ---------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------

export async function getVehicleClasses() {
  return unwrap(
    await supabase.from('vehicle_classes').select('*').eq('active', true).order('sort_order'),
  );
}

/**
 * Every rate version in force, normalised for the fare engine.
 *
 * RLS already hides versions dated into the future, so a staged price rise is
 * invisible to the app until it takes effect. `resolveRateVersion` then picks
 * the newest of what comes back.
 */
export async function getRates() {
  const rows = unwrap(
    await supabase
      .from('rate_versions')
      .select('*')
      .lte('effective_from', new Date().toISOString())
      .order('effective_from', { ascending: false }),
  );
  // Stored in toea already; `normaliseRateVersion` handles both shapes.
  return rows.map(normaliseRateVersion);
}

// ---------------------------------------------------------------------
// The vehicle list
// ---------------------------------------------------------------------

/**
 * Fetch the listable fleet and order it on the handset.
 *
 * `listable_vehicles` is the view that applies approval status and the
 * ten-minute presence window in the database. The ordering by straight-line
 * distance happens here, locally, because doing it any other way costs a
 * Directions call per row (spec §13, rule 1).
 */
export async function listAvailableVehicles({
  pickup,
  distanceKm,
  startAt,
  seatsNeeded = 1,
  excludeVehicleIds = [],
  rates,
  now = new Date(),
}) {
  const rows = unwrap(await supabase.from('listable_vehicles').select('*'));

  // Reshape the view into what the engine expects, then let it do the
  // ordering — the same `availableVehicles` the unit tests cover.
  const vehicles = rows.map((r) => ({
    id: r.id,
    class_code: r.class_code,
    make: r.make,
    model: r.model,
    year: r.year,
    colour: r.colour,
    seats: r.seats,
    registration_no: r.registration_no,
    status: 'APPROVED',
    rating_avg: r.rating_avg,
    rating_count: r.rating_count,
    trips_completed: r.trips_completed,
  }));

  const presence = rows.map((r) => ({
    vehicle_id: r.id,
    is_online: true,
    lat: r.lat,
    lng: r.lng,
    heading: r.heading,
    last_ping_at: r.last_ping_at,
  }));

  const list = availableVehicles({
    vehicles,
    presence,
    rates,
    pickup,
    distanceKm,
    startAt,
    seatsNeeded,
    excludeVehicleIds,
    now,
  });

  const byId = new Map(rows.map((r) => [r.id, r]));
  return list.map((row) => ({
    ...row,
    driverProfile: {
      full_name: byId.get(row.vehicle.id).driver_name,
      photo_url: byId.get(row.vehicle.id).driver_photo,
      rating_avg: byId.get(row.vehicle.id).driver_rating,
    },
  }));
}

export async function getVehicle(id) {
  return unwrap(await supabase.from('vehicles').select('*').eq('id', id).single());
}

/** The driver behind a vehicle — the public fields only, never the licence. */
export async function getDriverProfileForVehicle(vehicleId) {
  const { data, error } = await supabase
    .from('vehicles')
    .select('drivers ( profiles ( id, full_name, photo_url, rating_avg, rating_count ) )')
    .eq('id', vehicleId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.drivers?.profiles ?? null;
}

/** Where a vehicle is right now, for the pickup ETA. */
export async function getVehiclePresence(vehicleId) {
  const { data, error } = await supabase
    .from('listable_vehicles')
    .select('lat, lng, heading, last_ping_at')
    .eq('id', vehicleId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Price one class for a known distance.
 *
 * Not a network call — the rate table is already on the handset and the
 * arithmetic is `@wantok/core`. It lives here so screens have a single import
 * for "get me the number", and so the rate-version resolution happens in one
 * place rather than in every screen that shows a price.
 */
export function quoteForClass({ classCode, distanceKm, startAt, rates, now = new Date() }) {
  const rate = resolveRateVersion(rates, classCode, now);
  if (!rate) throw new Error(`No rate in force for ${classCode}`);
  return quote({ rate, distanceKm, startAt });
}

export async function getVehiclePhotos(vehicleId) {
  return unwrap(await supabase.from('vehicle_photos').select('*').eq('vehicle_id', vehicleId));
}

export async function getDriver(driverId) {
  const { data, error } = await supabase.from('drivers').select('*').eq('id', driverId).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Submit a vehicle for inspection.
 *
 * The status this can be created in is bounded by RLS: an owner may write
 * DRAFT / PENDING_DOCS / PENDING_INSPECTION and nothing else. An owner who
 * could set APPROVED could approve themselves, which would empty the word of
 * meaning.
 */
export async function createVehicle(fields) {
  return unwrap(await supabase.from('vehicles').insert(fields).select().single());
}

export async function addVehiclePhoto({ vehicle_id, angle, url }) {
  return unwrap(
    await supabase
      .from('vehicle_photos')
      .upsert({ vehicle_id, angle, url }, { onConflict: 'vehicle_id,angle' })
      .select()
      .single(),
  );
}

/**
 * Re-confirm a scheduled booking (spec §7, future flow).
 *
 * Not a state change — the booking is already CONFIRMED. This stamps
 * `reconfirmed_at`, which is what `shouldRelease` checks 45 minutes before
 * pickup. A driver who accepted six days ago and has ignored both reminders
 * has not confirmed anything about this morning.
 */
export async function reconfirmBooking(bookingId) {
  return unwrap(
    await supabase
      .from('bookings')
      .update({ reconfirmed_at: new Date().toISOString() })
      .eq('id', bookingId)
      .select()
      .single(),
  );
}

/**
 * Documents live in a private bucket and are served by short-lived signed
 * URLs (spec §16). Licences and NIDs are never publicly addressable, so there
 * is no `getPublicUrl` anywhere in this file.
 */
export async function signedUrl(bucket, path, seconds = 60) {
  const data = unwrap(await supabase.storage.from(bucket).createSignedUrl(path, seconds));
  return data.signedUrl;
}

export async function uploadDocument(bucket, path, file, contentType) {
  return unwrap(
    await supabase.storage.from(bucket).upload(path, file, { contentType, upsert: true }),
  );
}

// ---------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------

/**
 * Create a booking with the fare locked.
 *
 * The quote is computed on the handset from the rate table it already holds,
 * then stored. The `commission_within_fare` check constraint and the
 * `rate_version_id` foreign key are what stop a bad client writing a fare
 * nobody can explain later.
 */
export async function createBooking({
  customerId,
  vehicleId,
  driverId,
  pickup,
  destination,
  distanceKm,
  scheduledFor = null,
  rates,
  classCode,
  note = null,
  now = new Date(),
}) {
  const rate = resolveRateVersion(rates, classCode, now);
  if (!rate) throw new Error(`No rate in force for ${classCode}`);

  const startAt = scheduledFor ? new Date(scheduledFor) : now;
  const q = quote({ rate, distanceKm, startAt });

  return unwrap(
    await supabase
      .from('bookings')
      .insert({
        reference: makeReference(),
        customer_id: customerId,
        vehicle_id: vehicleId,
        driver_id: driverId,
        state: 'REQUESTED',
        is_scheduled: Boolean(scheduledFor),
        scheduled_for: scheduledFor,
        pickup_lat: pickup.lat,
        pickup_lng: pickup.lng,
        pickup_label: pickup.label,
        dest_lat: destination.lat,
        dest_lng: destination.lng,
        dest_label: destination.label,
        distance_km: distanceKm,
        rate_version_id: q.rateVersionId,
        is_night_rate: q.isNight,
        quoted_fare: q.fare,
        service_fee: q.serviceFee,
        commission_amount: q.commission,
        note_to_driver: note,
        share_token: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
        requested_at: now.toISOString(),
      })
      .select()
      .single(),
  );
}

/**
 * Apply a state transition.
 *
 * This goes through an edge function rather than a direct UPDATE, for one
 * reason: the transition has to be validated against the state the row is
 * actually in, atomically. Two drivers cannot both accept, and a queued
 * offline "arrived" cannot land on a booking that was cancelled an hour ago.
 * The function runs the same `applyEvent` from `@wantok/core` that the app
 * uses to grey out the button.
 */
export async function transition(bookingId, event, { payload = {}, occurredAt = new Date() } = {}) {
  return unwrap(
    await supabase.functions.invoke('booking-transition', {
      body: {
        booking_id: bookingId,
        event,
        payload,
        // Spec §14: a driver's queued action carries the time it happened,
        // not the time the connection came back.
        occurred_at: occurredAt.toISOString(),
      },
    }),
  );
}

export async function getBooking(id) {
  return unwrap(await supabase.from('bookings').select('*').eq('id', id).single());
}

export async function getMyBookings(customerId) {
  return unwrap(
    await supabase
      .from('bookings')
      .select('*')
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false }),
  );
}

export async function getDriverBookings(driverId) {
  return unwrap(
    await supabase
      .from('bookings')
      .select('*')
      .eq('driver_id', driverId)
      .order('created_at', { ascending: false }),
  );
}

/** Phone numbers, only while the window is open. The view enforces it. */
export async function getBookingContacts(bookingId) {
  const rows = unwrap(
    await supabase.from('booking_contacts').select('*').eq('booking_id', bookingId),
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------
// Presence and breadcrumbs
// ---------------------------------------------------------------------

export async function setDriverOnline(driverId, vehicleId, isOnline) {
  return unwrap(
    await supabase
      .from('driver_status')
      .upsert({
        driver_id: driverId,
        vehicle_id: vehicleId,
        is_online: isOnline,
        last_ping_at: new Date().toISOString(),
      })
      .select()
      .single(),
  );
}

/**
 * Location ping. Every 15 seconds idle, every 5 on a trip, never offline
 * (spec §13). Buffered and sent in batches when the connection is poor.
 */
export async function pingLocation(driverId, { lat, lng, heading }) {
  return unwrap(
    await supabase
      .from('driver_status')
      .update({ lat, lng, heading, last_ping_at: new Date().toISOString() })
      .eq('driver_id', driverId),
  );
}

export async function pushBreadcrumbs(bookingId, points) {
  if (!points.length) return null;
  return unwrap(
    await supabase.from('booking_locations').insert(
      points.map((p) => ({
        booking_id: bookingId,
        lat: p.lat,
        lng: p.lng,
        recorded_at: p.recordedAt,
      })),
    ),
  );
}

// ---------------------------------------------------------------------
// Realtime (spec §18 — driver positions and booking state)
// ---------------------------------------------------------------------

/** Watch one booking. Used by the customer's trip screen and the driver's. */
export function watchBooking(bookingId, onChange) {
  const channel = supabase
    .channel(`booking:${bookingId}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'bookings', filter: `id=eq.${bookingId}` },
      (payload) => onChange(payload.new),
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

/** New requests for this driver, with the 90-second countdown already running. */
export function watchDriverRequests(driverId, onRequest) {
  const channel = supabase
    .channel(`driver:${driverId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'bookings', filter: `driver_id=eq.${driverId}` },
      (payload) => onRequest(payload.new),
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

/** The driver's car moving on the customer's map. */
export function watchDriverPosition(driverId, onMove) {
  const channel = supabase
    .channel(`position:${driverId}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'driver_status', filter: `driver_id=eq.${driverId}` },
      (payload) => onMove(payload.new),
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// ---------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------

export async function getMessages(bookingId) {
  return unwrap(
    await supabase.from('messages').select('*').eq('booking_id', bookingId).order('sent_at'),
  );
}

export async function sendMessage(bookingId, senderId, body) {
  return unwrap(
    await supabase.from('messages').insert({ booking_id: bookingId, sender_id: senderId, body }).select().single(),
  );
}

export function watchMessages(bookingId, onMessage) {
  const channel = supabase
    .channel(`chat:${bookingId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `booking_id=eq.${bookingId}` },
      (payload) => onMessage(payload.new),
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// ---------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------

export async function getReviewsFor(subjectType, subjectId) {
  // The blind window is an RLS policy. Anything this returns is already
  // legitimately visible to the caller.
  return unwrap(
    await supabase
      .from('reviews')
      .select('*')
      .eq('subject_type', subjectType)
      .eq('subject_id', subjectId)
      .order('created_at', { ascending: false })
      .limit(20),
  );
}

export async function submitReview({ bookingId, subjectType, subjectId, stars, comment, tags }) {
  return unwrap(
    await supabase
      .from('reviews')
      .insert({
        booking_id: bookingId,
        subject_type: subjectType,
        subject_id: subjectId,
        stars,
        comment,
        tags,
      })
      .select()
      .single(),
  );
}

// ---------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------

export async function getLedger(vehicleId) {
  return unwrap(
    await supabase.from('ledger_entries').select('*').eq('vehicle_id', vehicleId).order('created_at'),
  );
}

export async function getPayments(ownerId) {
  return unwrap(
    await supabase.from('payments').select('*').eq('owner_id', ownerId).order('created_at', { ascending: false }),
  );
}

/**
 * Submit a payment receipt (spec §8, step 4).
 *
 * It changes nothing until an admin has matched it against the bank statement
 * — the RLS policy only lets an owner insert with status SUBMITTED, and only
 * an admin may update it.
 */
export async function submitPayment({ ownerId, vehicleId, amount, method, reference, receiptPath }) {
  return unwrap(
    await supabase
      .from('payments')
      .insert({
        owner_id: ownerId,
        vehicle_id: vehicleId,
        amount,
        method,
        reference,
        receipt_url: receiptPath,
        status: 'SUBMITTED',
      })
      .select()
      .single(),
  );
}

// ---------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------

/**
 * Fire an SOS (spec §10).
 *
 * An edge function, not an insert, because the four things that must happen
 * happen *simultaneously* and none of them can depend on the handset staying
 * alive: the admin alarm, the SMS to the emergency contact, the start of
 * location streaming, and the frozen audit record.
 */
export async function triggerSos({ bookingId, role, location }) {
  return unwrap(
    await supabase.functions.invoke('sos-trigger', {
      body: { booking_id: bookingId, role, lat: location?.lat, lng: location?.lng },
    }),
  );
}

/** Location streaming after a trigger: every 10 seconds for 60 minutes. */
export async function streamSosLocation(sosId, { lat, lng }) {
  return unwrap(
    await supabase.from('sos_locations').insert({
      sos_id: sosId,
      lat,
      lng,
      recorded_at: new Date().toISOString(),
    }),
  );
}

export async function raiseDispute({ bookingId, category, description }) {
  return unwrap(
    await supabase.from('disputes').insert({ booking_id: bookingId, category, description }).select().single(),
  );
}

export const SUPABASE_TIMINGS = Timing;
export { haversineKm };
