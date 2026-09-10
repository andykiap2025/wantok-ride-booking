/**
 * The admin console's data layer.
 *
 * One thing to be clear about, because it is the difference between a console
 * and a liability: **there is no privileged key in this browser.** The console
 * uses the anon key and the signed-in user's session, exactly like the phone
 * apps do. Its extra powers come from `is_admin()` branches in the RLS
 * policies, which means an admin's access is revoked by changing one array in
 * one row — not by rotating a key that has been sitting in someone's browser
 * for six months.
 *
 * The consequence is that everything here is a normal query. If a policy does
 * not allow it, the console cannot do it either, and that is the intended
 * design rather than an inconvenience to work around.
 */

import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);

const unwrap = ({ data, error }) => {
  if (error) throw new Error(error.message);
  return data;
};

// --- Auth ---------------------------------------------------------------

export const requestOtp = (phone) => unwrap(supabase.auth.signInWithOtp({ phone }));
export const verifyOtp = (phone, token) =>
  supabase.auth.verifyOtp({ phone, token, type: 'sms' }).then(unwrap);
export const signOut = () => supabase.auth.signOut();

export async function getSessionProfile() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return null;
  const profile = await supabase
    .from('profiles')
    .select('*')
    .eq('id', session.user.id)
    .single()
    .then(unwrap);
  return { session, profile };
}

// --- The live board ------------------------------------------------------

/**
 * Every trip currently in motion.
 *
 * The partial index `bookings_live_idx` covers exactly this predicate, so the
 * board stays cheap to refresh however large the bookings table gets.
 */
export const getLiveBoard = () =>
  supabase
    .from('bookings')
    .select('*, vehicles(registration_no, make, model, colour), profiles!bookings_customer_id_fkey(full_name, phone)')
    .in('state', ['REQUESTED', 'CONFIRMED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'])
    .order('created_at', { ascending: false })
    .then(unwrap);

export function watchLiveBoard(onChange) {
  const channel = supabase
    .channel('admin:board')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, onChange)
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// --- SOS -----------------------------------------------------------------

export const getOpenSos = () =>
  supabase
    .from('sos_events')
    .select('*')
    .is('acknowledged_at', null)
    .order('triggered_at', { ascending: false })
    .then(unwrap);

export const getRecentSos = (limit = 25) =>
  supabase
    .from('sos_events')
    .select('*')
    .order('triggered_at', { ascending: false })
    .limit(limit)
    .then(unwrap);

/** Acknowledging requires a note. The alarm cannot be clicked away. */
export const acknowledgeSos = (id, adminId, notes) =>
  supabase
    .from('sos_events')
    .update({ acknowledged_by: adminId, acknowledged_at: new Date().toISOString(), notes })
    .eq('id', id)
    .select()
    .single()
    .then(unwrap);

export function watchSos(onEvent) {
  const channel = supabase
    .channel('admin:sos')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sos_events' }, (p) =>
      onEvent(p.new),
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

export const getSosTrail = (sosId) =>
  supabase
    .from('sos_locations')
    .select('*')
    .eq('sos_id', sosId)
    .order('recorded_at')
    .then(unwrap);

// --- Approvals -----------------------------------------------------------

export const getPendingVehicles = () =>
  supabase
    .from('vehicles')
    .select('*, owners(nid_number, address, bank_name), drivers(licence_number, licence_class, licence_expiry, verified_at)')
    .in('status', ['PENDING_DOCS', 'PENDING_INSPECTION'])
    .order('created_at')
    .then(unwrap);

export const getVehicle = (id) =>
  supabase.from('vehicles').select('*, owners(*), drivers(*)').eq('id', id).single().then(unwrap);

export const getVehiclePhotos = (vehicleId) =>
  supabase.from('vehicle_photos').select('*').eq('vehicle_id', vehicleId).then(unwrap);

export const getInspections = (vehicleId) =>
  supabase
    .from('inspections')
    .select('*')
    .eq('vehicle_id', vehicleId)
    .order('inspected_at', { ascending: false })
    .then(unwrap);

export const saveInspection = (inspection) =>
  supabase.from('inspections').insert(inspection).select().single().then(unwrap);

/**
 * Approve a vehicle.
 *
 * This can fail, and it is supposed to: `vehicle_guard_approval` raises if the
 * six photos, the passing inspection or any of the three expiry dates are not
 * in order. The console shows the same blockers up front, but the database is
 * what makes it true.
 */
export const setVehicleStatus = (id, status, approvedBy) =>
  supabase
    .from('vehicles')
    .update({ status, ...(status === 'APPROVED' ? { approved_by: approvedBy } : {}) })
    .eq('id', id)
    .select()
    .single()
    .then(unwrap);

/** Private bucket. Documents are only ever served by short-lived signed URL. */
export const signedUrl = (bucket, path, seconds = 120) =>
  supabase.storage
    .from(bucket)
    .createSignedUrl(path, seconds)
    .then(unwrap)
    .then((d) => d.signedUrl);

// --- Rates ---------------------------------------------------------------

export const getVehicleClasses = () =>
  supabase.from('vehicle_classes').select('*').order('sort_order').then(unwrap);

export const getAllRates = () =>
  supabase
    .from('rate_versions')
    .select('*')
    .order('class_code')
    .order('effective_from', { ascending: false })
    .then(unwrap);

/**
 * Publish a new rate version.
 *
 * An INSERT, always. The table has a rule that discards UPDATEs, so there is
 * no way to change a historical rate even by accident — which is what lets an
 * old booking still be explained (spec §5).
 */
export const publishRate = (rate) =>
  supabase.from('rate_versions').insert(rate).select().single().then(unwrap);

// --- Money ---------------------------------------------------------------

export const getPendingPayments = () =>
  supabase
    .from('payments')
    .select('*, owners(bank_name, bank_account, profiles(full_name, phone))')
    .eq('status', 'SUBMITTED')
    .order('created_at')
    .then(unwrap);

/**
 * Mark a payment received.
 *
 * The ledger entry is what actually clears the balance; the triggers in 0002
 * recompute `balance_owed` and relist the vehicle if it was suspended for
 * non-payment. Nothing here writes a balance directly.
 */
export async function verifyPayment(payment, adminId) {
  await supabase
    .from('ledger_entries')
    .insert({
      vehicle_id: payment.vehicle_id,
      entry_type: 'PAYMENT',
      amount: payment.amount,
      note: `${payment.method} ${payment.reference ?? ''}`.trim(),
      created_by: adminId,
      balance_after: 0, // overwritten by ledger_set_balance()
    })
    .then(unwrap);

  return supabase
    .from('payments')
    .update({ status: 'VERIFIED', verified_by: adminId, verified_at: new Date().toISOString() })
    .eq('id', payment.id)
    .select()
    .single()
    .then(unwrap);
}

export const getLedger = (vehicleId) =>
  supabase.from('ledger_entries').select('*').eq('vehicle_id', vehicleId).order('created_at').then(unwrap);

export const getVehiclesWithBalance = () =>
  supabase
    .from('vehicles')
    .select('id, registration_no, make, model, status, balance_owed, commission_ceiling, owner_id')
    .gt('balance_owed', 0)
    .order('balance_owed', { ascending: false })
    .then(unwrap);

// --- Disputes and reviews -------------------------------------------------

export const getOpenDisputes = () =>
  supabase
    .from('disputes')
    .select('*, bookings(reference, quoted_fare, pickup_label, dest_label, state)')
    .in('status', ['OPEN', 'INVESTIGATING'])
    .order('created_at')
    .then(unwrap);

export const updateDispute = (id, patch) =>
  supabase.from('disputes').update(patch).eq('id', id).select().single().then(unwrap);

/** Hide, never delete. A hidden review is still evidence (spec §9). */
export const hideReview = (id, adminId, reason) =>
  supabase
    .from('reviews')
    .update({ visible: false, hidden_by: adminId, hidden_reason: reason, hidden_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()
    .then(unwrap);

// --- Reporting ------------------------------------------------------------

/**
 * Decline reasons.
 *
 * Spec §7: "Decline reasons are logged and reported. They are how you find out
 * which suburbs are underserved and at which hours." This is that report.
 */
export const getDeclineReasons = (sinceDays = 30) =>
  supabase
    .from('bookings')
    .select('decline_reason, pickup_label, dest_label, created_at')
    .not('decline_reason', 'is', null)
    .gte('created_at', new Date(Date.now() - sinceDays * 86_400_000).toISOString())
    .then(unwrap);

export const getFlaggedVehicles = (windowDays = 7) =>
  supabase
    .from('conduct_records')
    .select('*, vehicles(registration_no, make, model)')
    .eq('subject_type', 'VEHICLE')
    .gte('created_at', new Date(Date.now() - windowDays * 86_400_000).toISOString())
    .then(unwrap);

export const getAuditLog = (limit = 100) =>
  supabase
    .from('audit_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
    .then(unwrap);
