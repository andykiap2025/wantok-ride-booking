/**
 * scheduled-booking-cycle (spec §7, future flow)
 *
 * Runs every minute. Its whole job is the sentence in the spec:
 *
 *   > Never let a scheduled booking fail silently on the morning.
 *
 * Three passes:
 *
 *   1. **Reminders.** The driver at 18:00 the evening before and again 60
 *      minutes out, each with a re-confirm button. The customer 2 hours out.
 *   2. **Release.** At 45 minutes before pickup, any booking the driver has
 *      not re-confirmed is taken off him and handed back to the customer —
 *      with the customer told immediately, by push *and* SMS, because this is
 *      a failed booking and push alone is not reliable enough here (spec §12).
 *   3. **Strike.** A late release counts as a driver no-show against the
 *      vehicle's record. Not against the person; against the vehicle, which
 *      is what the owner is responsible for.
 *
 * Idempotency matters more than elegance: this runs 1,440 times a day and
 * must never send the same reminder twice. `notifications_sent` has a unique
 * constraint doing that work, and the insert is the gate.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { BookingEvent, applyEvent, reminderSchedule, shouldRelease } from '../_shared/core.ts';
import { sendSms } from '../_shared/sms.ts';
import { sendPush } from '../_shared/push.ts';

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

/**
 * Claim a notification. Returns false if it has already gone out.
 *
 * The unique index on (subject_type, subject_id, kind, threshold) is the lock.
 * Two overlapping runs of this job race to insert; exactly one wins.
 */
async function claim(bookingId: string, kind: string): Promise<boolean> {
  const { error } = await admin.from('notifications_sent').insert({
    subject_type: 'booking',
    subject_id: bookingId,
    kind,
    threshold: null,
  });
  return !error;
}

Deno.serve(async () => {
  const now = new Date();
  const summary = { reminders: 0, released: 0, errors: [] as string[] };

  // Everything confirmed and still ahead of us. Bounded by the partial index
  // `bookings_scheduled_idx`, so this stays cheap however large the table gets.
  const { data: bookings, error } = await admin
    .from('bookings')
    .select('*')
    .eq('is_scheduled', true)
    .eq('state', 'CONFIRMED')
    .gte('scheduled_for', now.toISOString());

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  for (const booking of bookings ?? []) {
    try {
      // --- Pass 1: reminders due right now ---------------------------
      for (const reminder of reminderSchedule(booking)) {
        if (reminder.kind === 'RELEASE_CHECK') continue;
        // A one-minute window, matching the cron cadence. A reminder whose
        // moment passed while the job was down is skipped rather than sent
        // late — a 60-minute warning delivered at 20 minutes is misleading.
        const due = reminder.at.getTime();
        if (due > now.getTime() || now.getTime() - due > 90_000) continue;
        if (!(await claim(booking.id, reminder.kind))) continue;

        if (reminder.audience === 'DRIVER') {
          await sendPush(booking.driver_id, {
            title: 'Confirm your booked trip',
            body: `${booking.pickup_label} → ${booking.dest_label}`,
            data: { bookingId: booking.id, action: 'RECONFIRM' },
          });
        } else {
          await sendPush(booking.customer_id, {
            title: 'Your ride is booked for later today',
            body: `Pick-up at ${booking.pickup_label}`,
            data: { bookingId: booking.id },
          });
        }
        summary.reminders += 1;
      }

      // --- Pass 2: release ------------------------------------------
      if (shouldRelease(booking, now)) {
        if (!(await claim(booking.id, 'RELEASED'))) continue;

        const released = applyEvent(booking, BookingEvent.RELEASE, { actor: 'system', now });

        const { error: writeError } = await admin
          .from('bookings')
          .update({
            state: released.state,
            cancelled_at: released.cancelled_at,
            released_at: released.released_at,
            cancelled_by: 'SYSTEM',
            cancel_reason: 'NOT_RECONFIRMED',
          })
          .eq('id', booking.id)
          .eq('state', 'CONFIRMED');

        if (writeError) {
          summary.errors.push(`${booking.id}: ${writeError.message}`);
          continue;
        }

        // The customer finds out immediately, and by two channels, because
        // this is a failed booking and there is still time to fix it.
        const { data: customer } = await admin
          .from('profiles')
          .select('phone')
          .eq('id', booking.customer_id)
          .single();

        const minutes = Math.round(
          (new Date(booking.scheduled_for).getTime() - now.getTime()) / 60_000,
        );

        await Promise.allSettled([
          sendPush(booking.customer_id, {
            title: 'Your driver did not confirm',
            body: 'Open Wantok Ride to book another vehicle — your fare is unchanged.',
            data: { bookingId: booking.id, action: 'REBOOK' },
          }),
          customer?.phone
            ? sendSms(
                customer.phone,
                `Wantok Ride: your driver has not confirmed your ${booking.pickup_label} pick-up. ` +
                  `We have released the booking so you can choose another vehicle. ` +
                  `About ${minutes} minutes until your pick-up time.`,
              )
            : Promise.resolve(null),
          sendPush(booking.driver_id, {
            title: 'Booking released',
            body: 'You did not re-confirm in time. This counts as a no-show against the vehicle.',
            data: { bookingId: booking.id },
          }),
        ]);

        // The strike itself is written by the `bookings_conduct` trigger, which
        // recognises EXPIRED-with-released_at as a driver no-show.
        summary.released += 1;
      }
    } catch (e) {
      summary.errors.push(`${booking.id}: ${(e as Error).message}`);
    }
  }

  return new Response(JSON.stringify(summary), {
    headers: { 'Content-Type': 'application/json' },
  });
});
