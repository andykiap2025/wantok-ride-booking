/**
 * SMS.
 *
 * Spec §12: anything involving money or a failed booking goes by SMS as well
 * as push, because push alone is not reliable enough on PNG networks. And
 * spec §10: the SOS message to an emergency contact is SMS because that
 * person does not have the app and may not have data.
 *
 * The provider is open decision #7 in the spec. This wraps whichever one is
 * chosen behind a single function so the decision touches one file. Twilio is
 * the default because it works from day one; a local aggregator will be
 * cheaper per message once volume justifies the integration work, and only
 * `send()` below has to change.
 *
 * Two operational habits baked in:
 *
 *   - **Every send is logged**, with its provider message id, whether it
 *     succeeded, and what it cost. When an owner says "I never got the
 *     suspension notice", that is a query, not an argument.
 *   - **Failures never throw into the caller.** An SOS whose SMS fails must
 *     still write its audit record and start its location stream. The caller
 *     gets a result object and decides.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

export interface SmsResult {
  ok: boolean;
  providerId?: string;
  error?: string;
}

/** GSM-7 fits 160 characters per segment; anything outside it drops to 70. */
export function segmentCount(body: string): number {
  const gsm7 = /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\[~\]|€\\]*$/;
  const limit = gsm7.test(body) ? 160 : 70;
  const perSegment = gsm7.test(body) ? 153 : 67;
  return body.length <= limit ? 1 : Math.ceil(body.length / perSegment);
}

async function viaTwilio(to: string, body: string): Promise<SmsResult> {
  const sid = Deno.env.get('TWILIO_ACCOUNT_SID');
  const token = Deno.env.get('TWILIO_AUTH_TOKEN');
  const from = Deno.env.get('TWILIO_FROM');

  if (!sid || !token || !from) {
    return { ok: false, error: 'SMS provider is not configured' };
  }

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${sid}:${token}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });

  const result = await response.json();
  if (!response.ok) {
    return { ok: false, error: result.message ?? `Provider returned ${response.status}` };
  }
  return { ok: true, providerId: result.sid };
}

/**
 * Send one SMS.
 *
 * Never throws. Every outcome is recorded, including the segment count, so
 * the monthly bill can be reconciled against what the platform actually sent.
 */
export async function sendSms(to: string, body: string): Promise<SmsResult> {
  let result: SmsResult;
  try {
    result = await viaTwilio(to, body);
  } catch (e) {
    result = { ok: false, error: (e as Error).message };
  }

  await admin
    .from('sms_log')
    .insert({
      to_number: to,
      body,
      segments: segmentCount(body),
      provider_id: result.providerId ?? null,
      ok: result.ok,
      error: result.error ?? null,
    })
    .then(
      () => {},
      // If even the log write fails there is nothing sensible left to do, and
      // an exception here would take down an SOS.
      () => {},
    );

  return result;
}
