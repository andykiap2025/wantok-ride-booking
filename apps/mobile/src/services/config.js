/**
 * Build configuration.
 *
 * `EXPO_PUBLIC_*` variables are inlined into the bundle at build time, so
 * everything here is public by definition. That is fine for the Supabase
 * anon key — it is designed to be shipped, and row-level security is what
 * actually protects the data. It is emphatically **not** fine for a service
 * role key, and there is no code path in this app that would accept one.
 *
 * The Google Maps key is also shipped, which is unavoidable for a client-side
 * SDK. Restrict it in the Google Cloud console to this app's package name and
 * SHA-1, and set a daily quota cap from day one (spec §13, rule 7). An
 * unrestricted key in a published APK is a bill waiting to happen.
 */

const required = (name, value) => {
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill it in, ` +
        'or set it in the EAS build profile.',
    );
  }
  return value;
};

export const SUPABASE_URL = required('EXPO_PUBLIC_SUPABASE_URL', process.env.EXPO_PUBLIC_SUPABASE_URL);
export const SUPABASE_ANON_KEY = required('EXPO_PUBLIC_SUPABASE_ANON_KEY', process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY);
export const GOOGLE_MAPS_KEY = required('EXPO_PUBLIC_GOOGLE_MAPS_KEY', process.env.EXPO_PUBLIC_GOOGLE_MAPS_KEY);

/**
 * Which shell boots.
 *
 * One codebase, two Play Store listings. The customer app and the driver app
 * share the domain engine, the design system and the Supabase client, and
 * differ only in which navigator mounts. Set in the EAS build profile.
 */
export const VARIANT = process.env.EXPO_PUBLIC_VARIANT ?? 'customer';

export const IS_CUSTOMER_APP = VARIANT === 'customer';
export const IS_DRIVER_APP = VARIANT === 'driver';

/** Where a shared trip-tracking link points (spec §10). */
export const TRACK_BASE_URL = process.env.EXPO_PUBLIC_TRACK_URL ?? 'https://track.wantokride.com';

export const SUPPORT_PHONE = process.env.EXPO_PUBLIC_SUPPORT_PHONE ?? '+67570000000';
