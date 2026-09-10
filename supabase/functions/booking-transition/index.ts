/**
 * booking-transition
 *
 * Every state change in the product goes through this function. It is the
 * only writer of `bookings.state`, and that is deliberate — the app greys out
 * a button using the same rules, but a greyed-out button is a courtesy, not
 * an enforcement.
 *
 * Three things only a server can guarantee, and all three are why this exists
 * rather than a direct UPDATE from the handset:
 *
 *   1. **Atomicity against the row's actual state.** Two drivers cannot both
 *      accept. A `SELECT ... FOR UPDATE` inside the transaction means the
 *      second one loses cleanly, with a reason.
 *
 *   2. **Replay safety.** A driver's queued offline "arrived" can land hours
 *      later, on a booking the passenger cancelled in the meantime. The
 *      transition is validated against the state the row is in *now*, and
 *      rejected if it no longer applies.
 *
 *   3. **Honest timestamps.** `occurred_at` comes from the handset — the
 *      moment of the tap, not the moment the connection returned (spec §14).
 *      It is clamped to a sane window so a phone with a broken clock cannot
 *      write a trip that started last week.
 *
 * The rules themselves are not here. `applyEvent` is the same function the
 * apps import and the unit tests cover.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { applyEvent, canApply, BookingEvent } from '../_shared/core.ts';

/** A handset clock this far out is not to be trusted. */
const MAX_CLOCK_SKEW_MS = 6 * 60 * 60 * 1000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  const authorization = req.headers.get('Authorization');
  if (!authorization) return json({ error: 'Not signed in' }, 401);

  // Two clients: one as the caller, to find out who they are under RLS, and
  // one as the service role, to perform the write. The caller's identity is
  // never taken from the request body.
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

  let payload: {
    booking_id: string;
    event: string;
    payload?: Record<string, unknown>;
    occurred_at?: string;
  };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Bad request body' }, 400);
  }

  const { booking_id, event, payload: eventPayload = {}, occurred_at } = payload;
  if (!booking_id || !event) return json({ error: 'booking_id and event are required' }, 400);
  if (!Object.values(BookingEvent).includes(event)) {
    return json({ error: `Unknown event: ${event}` }, 400);
  }

  // --- Who is asking? --------------------------------------------------

  const { data: booking, error: readError } = await admin
    .from('bookings')
    .select('*')
    .eq('id', booking_id)
    .single();
  if (readError || !booking) return json({ error: 'Booking not found' }, 404);

  const { data: driver } = await admin
    .from('drivers')
    .select('id')
    .eq('profile_id', user.id)
    .maybeSingle();

  const { data: adminRow } = await admin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  const isAdmin = (adminRow?.role ?? []).some((r: string) => r === 'ADMIN' || r === 'SUPER_ADMIN');

  let actor: 'customer' | 'driver' | 'system';
  if (booking.customer_id === user.id) actor = 'customer';
  else if (driver && booking.driver_id === driver.id) actor = 'driver';
  else if (isAdmin) actor = 'system';
  else return json({ error: 'You are not on this booking' }, 403);

  // --- When did it happen? ---------------------------------------------

  const now = new Date();
  let occurredAt = occurred_at ? new Date(occurred_at) : now;

  // A queued action carries the time of the tap. A clock that disagrees with
  // the server by more than a working day is broken, not offline, and the
  // server's time is the safer of the two.
  if (Number.isNaN(occurredAt.getTime()) || Math.abs(now.getTime() - occurredAt.getTime()) > MAX_CLOCK_SKEW_MS) {
    occurredAt = now;
  }
  // Never accept a future timestamp: it would push a no-show grace period out.
  if (occurredAt > now) occurredAt = now;

  // --- Apply ------------------------------------------------------------

  const verdict = canApply(booking, event, { actor, payload: eventPayload, now: occurredAt });
  if (!verdict.ok) {
    // 409, not 400: the request was well formed, the world moved on. The
    // offline queue treats this as "drop it" rather than "retry forever".
    return json({ error: verdict.error, state: booking.state }, 409);
  }

  const next = applyEvent(booking, event, { actor, payload: eventPayload, now: occurredAt });

  // Only write the columns the transition actually touched. A blind upsert of
  // the whole row would let a stale handset overwrite a fare or a destination.
  const changed: Record<string, unknown> = { state: next.state };
  for (const column of [
    'requested_at', 'confirmed_at', 'en_route_at', 'arrived_at', 'started_at',
    'completed_at', 'cancelled_at', 'released_at', 'cancelled_by', 'cancel_reason',
    'decline_reason', 'decline_note',
  ]) {
    if (next[column] !== booking[column]) changed[column] = next[column];
  }

  const { data: updated, error: writeError } = await admin
    .from('bookings')
    .update(changed)
    // The guard that makes concurrent accepts safe: the update only applies
    // if the row is still in the state we validated against.
    .eq('id', booking_id)
    .eq('state', booking.state)
    .select()
    .single();

  if (writeError || !updated) {
    return json({ error: 'That booking has already changed. Refresh and try again.' }, 409);
  }

  await admin.from('audit_log').insert({
    actor_id: user.id,
    action: `BOOKING_${event}`,
    entity_type: 'booking',
    entity_id: booking_id,
    before: { state: booking.state },
    after: { state: updated.state, occurred_at: occurredAt.toISOString() },
  });

  return json(updated);
});
