/**
 * sos-trigger (spec §10)
 *
 * Four things must happen, simultaneously, and none of them can depend on the
 * handset staying alive or in coverage:
 *
 *   1. Admin alert — loud, repeating, undismissable without a note.
 *   2. SMS to the emergency contact of whoever triggered it. Plain SMS,
 *      because the contact does not have the app.
 *   3. Location streaming for the next 60 minutes.
 *   4. A full audit record, frozen at that moment.
 *
 * Two rules that are easy to get wrong and matter enormously:
 *
 *   - **The trip is not cancelled.** Nothing here touches `bookings.state`.
 *   - **The other party is never told.** A passenger who pressed SOS because
 *     of the driver must not have the driver's phone light up about it. There
 *     is no notification to the counterparty anywhere in this function.
 *
 * The SMS is sent before the response returns, not queued, because the whole
 * point is that it goes out even if the handset dies one second later.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { buildSosEvent, emergencyContactSms } from '../_shared/core.ts';
import { sendSms } from '../_shared/sms.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  const authorization = req.headers.get('Authorization');
  if (!authorization) return json({ error: 'Not signed in' }, 401);

  const asUser = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authorization } } },
  );
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const {
    data: { user },
  } = await asUser.auth.getUser();
  if (!user) return json({ error: 'Not signed in' }, 401);

  const { booking_id, role, lat, lng } = await req.json();

  // --- Gather everything, then freeze it -------------------------------

  let booking = null;
  let vehicle = null;
  let driverProfile = null;
  let customerProfile = null;

  if (booking_id) {
    const { data } = await admin.from('bookings').select('*').eq('id', booking_id).single();
    booking = data;

    if (booking) {
      const [{ data: v }, { data: c }] = await Promise.all([
        admin.from('vehicles').select('*').eq('id', booking.vehicle_id).single(),
        admin.from('profiles').select('*').eq('id', booking.customer_id).single(),
      ]);
      vehicle = v;
      customerProfile = c;

      if (vehicle?.driver_id) {
        const { data: d } = await admin
          .from('drivers')
          .select('profile_id')
          .eq('id', vehicle.driver_id)
          .single();
        if (d) {
          const { data: dp } = await admin.from('profiles').select('*').eq('id', d.profile_id).single();
          driverProfile = dp;
        }
      }
    }
  } else {
    const { data } = await admin.from('profiles').select('*').eq('id', user.id).single();
    if (role === 'DRIVER') driverProfile = data;
    else customerProfile = data;
  }

  const event = buildSosEvent({
    booking,
    vehicle,
    driverProfile,
    customerProfile,
    triggeredBy: user.id,
    role,
    location: lat && lng ? { lat, lng } : null,
    now: new Date(),
  });

  const { data: saved, error } = await admin
    .from('sos_events')
    .insert({
      booking_id: booking_id ?? null,
      triggered_by: user.id,
      role,
      lat: lat ?? null,
      lng: lng ?? null,
      snapshot: event.snapshot,
    })
    .select()
    .single();

  if (error) return json({ error: error.message }, 500);

  // --- Tell the people who can help ------------------------------------

  const trackingUrl = booking?.share_token
    ? `${Deno.env.get('TRACK_BASE_URL') ?? 'https://track.wantokride.com'}/sos/${saved.id}`
    : undefined;

  const contact =
    role === 'CUSTOMER'
      ? customerProfile?.emergency_contact_phone
      : driverProfile?.emergency_contact_phone;

  // The emergency contact first — it is the message that reaches a human who
  // is not on a roster and does not need to be woken up.
  const results = await Promise.allSettled([
    contact
      ? sendSms(contact, emergencyContactSms({ ...event, id: saved.id }, { trackingUrl }))
      : Promise.resolve(null),

    // The on-call phone. An SOS with nobody on the other end is worse than no
    // button at all — see docs/sos-escalation.md for the roster this assumes.
    sendSms(
      Deno.env.get('ONCALL_PHONE')!,
      `WANTOK RIDE SOS. ${role}. Booking ${event.snapshot.reference ?? 'none'}. ` +
        `Vehicle ${event.snapshot.vehicle?.registration_no ?? 'unknown'}. ` +
        `Open the admin console and acknowledge within 2 minutes.`,
    ),
  ]);

  await admin.from('audit_log').insert({
    actor_id: user.id,
    action: 'SOS_TRIGGERED',
    entity_type: 'sos_event',
    entity_id: saved.id,
    after: {
      role,
      emergency_sms: results[0].status,
      oncall_sms: results[1].status,
    },
  });

  // Returned so the handset can start its 60-minute location stream. Note
  // what is not returned and not sent: anything at all to the other party.
  return json({ id: saved.id, triggered_at: saved.triggered_at });
});
