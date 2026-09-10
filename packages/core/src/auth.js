/**
 * Phone OTP sign-in and contact exposure (spec §11, §16).
 *
 * No passwords anywhere in the product, for any role. A driver in Gerehu is
 * not going to maintain a password, and a password reset flow over email is
 * worse than useless when half the fleet has no email address.
 *
 * The verification logic here is the *rules* — six digits, five minutes, three
 * attempts, fifteen-minute lockout. The codes themselves are issued and
 * checked server-side; a client that could verify its own OTP has no OTP.
 */

import { Timing } from './constants.js';

// --- PNG phone numbers ---------------------------------------------------

export const PNG_DIAL_CODE = '+675';

/**
 * PNG mobile numbers are 8 digits and start with 7 (Digicel, Vodafone) or 8.
 * Landlines are 7 digits. Only mobiles can receive an OTP, so only mobiles
 * can hold an account.
 */
export function normalisePhone(input, dialCode = PNG_DIAL_CODE) {
  const digits = String(input ?? '').replace(/[^\d]/g, '');
  if (!digits) return null;
  const local = digits.startsWith('675') ? digits.slice(3) : digits;
  return `${dialCode}${local}`;
}

export function isValidPngMobile(input) {
  const normalised = normalisePhone(input);
  if (!normalised) return false;
  const local = normalised.slice(PNG_DIAL_CODE.length);
  return /^[78]\d{7}$/.test(local);
}

/** "7412 8860" — how a number is written and read out in PNG. */
export function formatPngMobile(input) {
  const normalised = normalisePhone(input);
  if (!normalised) return '';
  const local = normalised.slice(PNG_DIAL_CODE.length);
  if (local.length !== 8) return local;
  return `${local.slice(0, 4)} ${local.slice(4)}`;
}

// --- OTP -----------------------------------------------------------------

export const OtpError = {
  EXPIRED: 'EXPIRED',
  WRONG: 'WRONG',
  LOCKED: 'LOCKED',
  USED: 'USED',
};

/** Six digits, never starting with a zero-run that reads as a short code. */
export function generateOtp(random = Math.random) {
  let code = '';
  for (let i = 0; i < Timing.OTP_LENGTH; i += 1) {
    code += Math.floor(random() * 10);
  }
  return code;
}

export function createChallenge({ phone, code, now = new Date() }) {
  return {
    phone: normalisePhone(phone),
    code,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + Timing.OTP_EXPIRY_MINUTES * 60_000).toISOString(),
    attempts: 0,
    locked_until: null,
    consumed_at: null,
  };
}

/**
 * Check a code. Returns the updated challenge either way — the attempt count
 * has to persist even on a failure, or three attempts means nothing.
 */
export function verifyOtp(challenge, submitted, now = new Date()) {
  if (challenge.consumed_at) {
    return { ok: false, code: OtpError.USED, error: 'That code has already been used', challenge };
  }
  if (challenge.locked_until && now.getTime() < new Date(challenge.locked_until).getTime()) {
    const mins = Math.ceil((new Date(challenge.locked_until).getTime() - now.getTime()) / 60_000);
    return {
      ok: false,
      code: OtpError.LOCKED,
      error: `Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
      challenge,
    };
  }
  if (now.getTime() > new Date(challenge.expires_at).getTime()) {
    return { ok: false, code: OtpError.EXPIRED, error: 'That code has expired. Ask for a new one.', challenge };
  }

  if (String(submitted).trim() !== challenge.code) {
    const attempts = challenge.attempts + 1;
    const locked = attempts >= Timing.OTP_MAX_ATTEMPTS;
    return {
      ok: false,
      code: locked ? OtpError.LOCKED : OtpError.WRONG,
      error: locked
        ? `Too many attempts. Try again in ${Timing.OTP_LOCKOUT_MINUTES} minutes.`
        : `Wrong code. ${Timing.OTP_MAX_ATTEMPTS - attempts} attempt${
            Timing.OTP_MAX_ATTEMPTS - attempts === 1 ? '' : 's'
          } left.`,
      challenge: {
        ...challenge,
        attempts,
        locked_until: locked
          ? new Date(now.getTime() + Timing.OTP_LOCKOUT_MINUTES * 60_000).toISOString()
          : null,
      },
    };
  }

  return {
    ok: true,
    challenge: { ...challenge, consumed_at: now.toISOString() },
  };
}

// --- Contact exposure ----------------------------------------------------

/**
 * Whether two parties may see each other's phone number (spec §11, §15).
 *
 * Numbers are exchanged only after CONFIRMED, and only for the duration of the
 * booking plus 24 hours. In the database this is enforced by a view; this
 * function is the same rule for the apps, so a button is greyed out rather
 * than failing when tapped.
 */
export function contactWindowOpen(booking, now = new Date()) {
  if (!booking?.confirmed_at) return false;

  const ended = booking.completed_at ?? booking.cancelled_at;
  if (!ended) return true; // trip is live

  const closesAt = new Date(ended).getTime() + Timing.CONTACT_WINDOW_HOURS * 3_600_000;
  return now.getTime() < closesAt;
}

/** Chat closes on exactly the same clock as the phone number. */
export const chatWindowOpen = contactWindowOpen;

/**
 * Emergency contact verification (spec §10).
 *
 * Mandatory at signup, and verified with a real SMS before the account can
 * book or drive — an unverified number in that field is a number that will not
 * answer on the night it matters.
 */
export function emergencyContactComplete(profile) {
  return Boolean(
    profile?.emergency_contact_name?.trim() &&
      isValidPngMobile(profile?.emergency_contact_phone) &&
      profile?.emergency_verified_at,
  );
}

export function validateEmergencyContact({ name, phone, ownPhone }) {
  if (!name?.trim()) return { ok: false, error: 'Enter the contact’s name' };
  if (!isValidPngMobile(phone)) return { ok: false, error: 'Enter a valid PNG mobile number' };
  if (ownPhone && normalisePhone(phone) === normalisePhone(ownPhone)) {
    // Nominating yourself defeats the entire point of the field.
    return { ok: false, error: 'Your emergency contact cannot be your own number' };
  }
  return { ok: true };
}
