/**
 * Push, via Expo Notifications.
 *
 * Push is the cheap channel and the unreliable one. Spec §12 sets the rule
 * plainly: anything involving money or a failed booking goes by SMS *as well*.
 * So nothing in the product should treat a successful push as delivery — this
 * function is best-effort by design, and the callers that matter pair it with
 * `sendSms`.
 *
 * Expired tokens are pruned on the spot. A phone that has been wiped or had
 * the app removed returns DeviceNotRegistered, and keeping that token means
 * every future send wastes a request and muddies the delivery figures.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

const EXPO_PUSH = 'https://exp.host/--/api/v2/push/send';

export interface PushMessage {
  title: string;
  body?: string;
  data?: Record<string, unknown>;
  /** Booking requests and arrivals wake the phone; the rest do not. */
  sound?: boolean;
}

/**
 * Send to every device registered to a profile.
 *
 * `profileId` may be a driver id in some callers — resolve to the profile
 * first, because tokens belong to a person, not to a role.
 */
export async function sendPush(profileId: string, message: PushMessage): Promise<void> {
  const { data: tokens } = await admin
    .from('push_tokens')
    .select('token')
    .eq('profile_id', profileId);

  if (!tokens?.length) return;

  const messages = tokens.map((t) => ({
    to: t.token,
    title: message.title,
    body: message.body,
    data: message.data ?? {},
    sound: message.sound ? 'default' : null,
    priority: 'high',
    channelId: 'wantok-default',
  }));

  try {
    const response = await fetch(EXPO_PUSH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    });

    const result = await response.json();
    const receipts = result?.data ?? [];

    const dead = receipts
      .map((r: { status: string; details?: { error?: string } }, i: number) =>
        r.status === 'error' && r.details?.error === 'DeviceNotRegistered' ? tokens[i].token : null,
      )
      .filter(Boolean);

    if (dead.length) {
      await admin.from('push_tokens').delete().in('token', dead);
    }
  } catch {
    // Best effort, always. Anything that actually matters is also going by SMS.
  }
}
