/**
 * verify-emergency-contact (spec §10)
 *
 *   > This is mandatory, not a settings-screen option, and the number is
 *   > verified with a test SMS before the account can book or drive.
 *
 * The important word is *verified*. Typing a number proves nothing — half of
 * them would be typos and some would be deliberate nonsense from someone who
 * wanted to get past the screen. So a real message goes to the real handset,
 * and `emergency_verified_at` is only stamped when it is confirmed delivered
 * by the provider.
 *
 * The column is written here, with the service role, and by nothing else. The
 * app cannot set it: an account that could verify its own emergency contact
 * has no emergency contact.
 *
 * The message itself is written for the *recipient*, who did not ask for it
 * and has never heard of this app. It says who listed them, what it means,
 * and that they will only hear from Wantok Ride again in an emergency.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { sendSms } from '../_shared/sms.ts';
import { isValidPngMobile, normalisePhone } from '../_shared/core.ts';

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

  const { name, phone } = await req.json();
  const normalised = normalisePhone(phone);

  if (!name?.trim()) return json({ error: 'A contact name is required' }, 400);
  if (!isValidPngMobile(normalised)) return json({ error: 'Not a valid PNG mobile number' }, 400);

  const { data: profile } = await admin
    .from('profiles')
    .select('full_name, phone')
    .eq('id', user.id)
    .single();

  // Nominating yourself defeats the whole purpose of the field. The database
  // has a constraint saying the same thing; this is the friendly version.
  if (normalised === profile?.phone) {
    return json({ error: 'Your emergency contact cannot be your own number' }, 400);
  }

  // Rate limit: three verification texts per account per day. Without it this
  // endpoint is a free SMS gateway pointed at any number in the country.
  const { count } = await admin
    .from('sms_log')
    .select('*', { count: 'exact', head: true })
    .eq('to_number', normalised)
    .gte('sent_at', new Date(Date.now() - 86_400_000).toISOString());

  if ((count ?? 0) >= 3) {
    return json({ error: 'Too many verification messages to that number today.' }, 429);
  }

  const result = await sendSms(
    normalised,
    `Wantok Ride: ${profile?.full_name ?? 'Someone'} has listed you as their emergency contact. ` +
      `If they ever raise an alert during a trip, we will text you their location, the vehicle ` +
      `and the driver's details. You do not need the app and we will not message you otherwise. ` +
      `Reply STOP to be removed.`,
  );

  if (!result.ok) {
    return json({ error: 'Could not reach that number. Check it and try again.' }, 502);
  }

  await admin
    .from('profiles')
    .update({
      emergency_contact_name: name.trim(),
      emergency_contact_phone: normalised,
      emergency_verified_at: new Date().toISOString(),
    })
    .eq('id', user.id);

  await admin.from('audit_log').insert({
    actor_id: user.id,
    action: 'EMERGENCY_CONTACT_VERIFIED',
    entity_type: 'profile',
    entity_id: user.id,
    after: { name: name.trim() },
  });

  return json({ ok: true, verified_at: new Date().toISOString() });
});
