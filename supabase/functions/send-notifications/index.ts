/**
 * send-notifications
 *
 * The sender behind the two cron jobs that need to reach a person rather than
 * just change a row: document expiry warnings (spec §6) and the Monday owner
 * statement (spec §8).
 *
 * Called only by pg_cron, through `invoke_edge_function`, with the service
 * role key. Nothing else should reach it, and the role check below is what
 * makes that true — a valid user JWT is not enough.
 *
 * Two habits run through both handlers:
 *
 *   **Idempotency is the database's job.** `send_document_warnings` claims
 *   each warning in `notifications_sent` *before* calling here, so a job that
 *   runs twice sends once. The statement handler claims its own key for the
 *   same reason. A notification system that cannot survive a retry will
 *   eventually text somebody six times at 3am.
 *
 *   **A failed send is logged, never thrown.** One owner with a dead number
 *   must not stop the other eleven getting their statement. Every outcome is
 *   counted and returned, so a bad run is visible in the cron history rather
 *   than silent.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { buildStatement, ceilingState, formatKina, weekStart } from '../_shared/core.ts';
import { sendPush } from '../_shared/push.ts';
import { sendSms } from '../_shared/sms.ts';

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** The `role` claim, read without verifying — the gateway already verified. */
function roleOf(authorization: string | null): string | null {
  if (!authorization?.startsWith('Bearer ')) return null;
  try {
    const payload = authorization.slice(7).split('.')[1];
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).role ?? null;
  } catch {
    return null;
  }
}

interface DocItem {
  vehicle_id: string;
  owner_id: string;
  driver_id: string | null;
  registration_no: string;
  kind: string;
  label: string;
  expiry: string;
  days_left: number;
  threshold: number;
}

/**
 * Document expiry warnings at 30, 14 and 7 days.
 *
 * Spec §12's table has this as push to the owner and the driver, with an
 * alert to admin. The 7-day warning also goes by SMS, which is a deliberate
 * step beyond the table: it is the last notice before the vehicle is
 * suspended automatically and stops earning, and spec §12's own rule is that
 * anything involving money goes by SMS as well as push.
 */
async function sendDocWarnings(items: DocItem[]) {
  const result = { sent: 0, sms: 0, failed: 0 };

  for (const item of items) {
    try {
      // Resolve the people. The owner is who fixes it; the driver is who
      // stops earning if they do not.
      const { data: owner } = await admin
        .from('owners')
        .select('profile_id, profiles(full_name, phone)')
        .eq('id', item.owner_id)
        .maybeSingle();

      const { data: driver } = item.driver_id
        ? await admin
            .from('drivers')
            .select('profile_id, profiles(full_name, phone)')
            .eq('id', item.driver_id)
            .maybeSingle()
        : { data: null };

      const days = item.days_left;
      const urgent = item.threshold <= 7;

      const title = urgent
        ? `${item.label} expires in ${days} day${days === 1 ? '' : 's'}`
        : `${item.label} expiring soon`;

      const body =
        `${item.registration_no}: ${item.label.toLowerCase()} expires ${item.expiry}. ` +
        (urgent
          ? 'The vehicle comes off Wantok Ride automatically on that date.'
          : `${days} days left — upload a current one in the app.`);

      const targets = [owner?.profile_id, driver?.profile_id].filter(Boolean) as string[];
      await Promise.allSettled(
        targets.map((id) =>
          sendPush(id, { title, body, sound: urgent, data: { vehicleId: item.vehicle_id } }),
        ),
      );
      result.sent += targets.length;

      // The last warning before the vehicle stops earning. Push alone is not
      // reliable enough here (spec §12).
      if (urgent) {
        const numbers = [
          (owner?.profiles as { phone?: string } | null)?.phone,
          (driver?.profiles as { phone?: string } | null)?.phone,
        ].filter(Boolean) as string[];

        const text =
          `Wantok Ride: ${item.registration_no} — ${item.label.toLowerCase()} expires ${item.expiry} ` +
          `(${days} day${days === 1 ? '' : 's'}). The vehicle will come off the app on that date ` +
          `until a current one is approved.`;

        const sent = await Promise.allSettled(numbers.map((n) => sendSms(n, text)));
        result.sms += sent.filter((s) => s.status === 'fulfilled').length;
      }

      await admin.from('audit_log').insert({
        action: 'DOC_EXPIRY_WARNING',
        entity_type: 'vehicle',
        entity_id: item.vehicle_id,
        after: { kind: item.kind, threshold: item.threshold, days_left: days },
      });
    } catch (e) {
      result.failed += 1;
      console.error('doc warning failed', item.vehicle_id, item.kind, (e as Error).message);
    }
  }

  return result;
}

/**
 * The Monday statement (spec §8).
 *
 *   > The owner should never need to ask what they owe.
 *
 * Shaped like a bank statement because that is the shape owners already know
 * how to read: opening balance, the week's trips, what was paid, closing
 * balance. `buildStatement` in @wantok/core does the arithmetic — the same
 * function the owner's own earnings screen uses, so the number in the message
 * and the number in the app cannot drift.
 */
async function sendWeeklyStatements(now: Date) {
  const from = weekStart(new Date(now.getTime() - 7 * 86_400_000)); // last week
  const to = weekStart(now);
  const period = from.toISOString().slice(0, 10);
  const result = { owners: 0, vehicles: 0, skipped: 0, failed: 0 };

  const { data: vehicles, error } = await admin
    .from('vehicles')
    .select('id, registration_no, commission_ceiling, balance_owed, status, owner_id, owners(profile_id, profiles(full_name, phone))')
    .not('status', 'in', '("DRAFT","REJECTED","RETIRED")');

  if (error) throw new Error(error.message);

  // Group by owner: one message per person, not one per vehicle. An owner
  // with four cars should get a single Monday message.
  const byOwner = new Map<string, typeof vehicles>();
  for (const v of vehicles ?? []) {
    const list = byOwner.get(v.owner_id) ?? [];
    list.push(v);
    byOwner.set(v.owner_id, list);
  }

  for (const [ownerId, fleet] of byOwner) {
    try {
      // Claim it. A cron job that fires twice must not send two statements.
      //
      // The period is part of the key, not just the owner. `notifications_sent`
      // is unique on (subject_type, subject_id, kind, threshold) with nulls
      // treated as equal, so keying on the owner alone would let each owner
      // receive exactly one statement ever — the claim would succeed in week
      // one and collide silently every Monday after.
      const { error: claimError } = await admin.from('notifications_sent').insert({
        subject_type: 'owner_statement',
        subject_id: `${ownerId}:${period}`,
        kind: 'WEEKLY_STATEMENT',
        threshold: null,
      });
      // A unique violation means this week's statement already went out.
      if (claimError) {
        result.skipped += 1;
        continue;
      }

      const lines: string[] = [];
      let totalOwed = 0;
      let totalTrips = 0;

      for (const v of fleet) {
        const { data: entries } = await admin
          .from('ledger_entries')
          .select('*')
          .eq('vehicle_id', v.id)
          .order('created_at');

        const statement = buildStatement({ entries: entries ?? [], from, to, vehicle: v });
        const ceiling = ceilingState(statement.closingBalance, v.commission_ceiling);
        totalOwed += statement.closingBalance;
        totalTrips += statement.trips;

        lines.push(
          `${v.registration_no}: ${statement.trips} trip${statement.trips === 1 ? '' : 's'}, ` +
            `${formatKina(statement.grossFares)} in fares, ` +
            `${formatKina(statement.commissionCharged)} commission` +
            (statement.paymentsReceived > 0 ? `, ${formatKina(statement.paymentsReceived)} paid` : '') +
            `. Balance ${formatKina(statement.closingBalance)}` +
            (ceiling.state === 'OVER' ? ' — SUSPENDED, please settle' :
             ceiling.state === 'WARN' ? ' — close to the limit' : ''),
        );
        result.vehicles += 1;
      }

      const owner = fleet[0].owners as { profile_id: string; profiles?: { phone?: string } } | null;
      if (!owner?.profile_id) {
        result.failed += 1;
        continue;
      }

      await sendPush(owner.profile_id, {
        title: `Your week: ${totalTrips} trip${totalTrips === 1 ? '' : 's'}, ${formatKina(totalOwed)} owed`,
        body: lines.join(' · '),
        data: { kind: 'WEEKLY_STATEMENT', period },
      });

      // SMS only when there is money outstanding. A statement saying "you owe
      // nothing" is not worth a segment, and an owner who gets a text every
      // Monday regardless stops reading them.
      if (totalOwed > 0 && owner.profiles?.phone) {
        await sendSms(
          owner.profiles.phone,
          `Wantok Ride week to ${period}: ${totalTrips} trip${totalTrips === 1 ? '' : 's'}, ` +
            `${formatKina(totalOwed)} commission owed. Open the app to see the breakdown or send a payment receipt.`,
        );
      }

      result.owners += 1;
    } catch (e) {
      result.failed += 1;
      console.error('statement failed for owner', ownerId, (e as Error).message);
    }
  }

  return result;
}

Deno.serve(async (req) => {
  // Only the scheduler. A signed-in user holding a valid JWT must not be able
  // to make the platform send SMS on demand.
  if (roleOf(req.headers.get('Authorization')) !== 'service_role') {
    return json({ error: 'This endpoint is for scheduled jobs only' }, 403);
  }

  let payload: { kind?: string; items?: DocItem[] };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Bad request body' }, 400);
  }

  const now = new Date();

  try {
    switch (payload.kind) {
      case 'DOC_EXPIRY':
        return json({ kind: payload.kind, ...(await sendDocWarnings(payload.items ?? [])) });

      case 'WEEKLY_STATEMENT':
        return json({ kind: payload.kind, ...(await sendWeeklyStatements(now)) });

      default:
        return json({ error: `Unknown kind: ${payload.kind}` }, 400);
    }
  } catch (e) {
    // Returned rather than thrown, so the failure lands in cron.job_run_details
    // as a result somebody can read instead of an opaque 500.
    console.error('send-notifications failed', (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
