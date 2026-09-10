/**
 * Notifications — the seam, not the implementation.
 *
 * In production this splits three ways: Expo Notifications for push, an SMS
 * aggregator for anything involving money or a failed booking (spec §12 —
 * "push alone is not reliable enough on PNG networks"), and the admin
 * console's alarm channel for SOS.
 *
 * Here it records what *would* have been sent, and the Developer screen shows
 * the log. That is more useful than a silent no-op: you can see at a glance
 * that a suspension went out by SMS and a booking confirmation did not.
 */

const log = [];
const listeners = new Set();

export function subscribeToNotifications(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * @param audience  CUSTOMER | DRIVER | OWNER | ADMIN
 * @param title     Short, readable on a lock screen
 * @param body      Optional detail
 * @param channels  { sound, sms, alarm }
 */
export function notify(audience, title, body, channels = {}) {
  const entry = {
    id: `ntf-${log.length + 1}`,
    audience,
    title,
    body: body ?? null,
    push: true,
    sms: Boolean(channels.sms),
    sound: Boolean(channels.sound),
    alarm: Boolean(channels.alarm),
    at: new Date().toISOString(),
  };
  log.unshift(entry);
  listeners.forEach((fn) => fn(entry));
  return entry;
}

export const getNotificationLog = () => log;

export function clearNotificationLog() {
  log.length = 0;
}
