/**
 * Offline-first storage (spec §14).
 *
 * Assume patchy coverage and expensive data. Two mechanisms:
 *
 * **A local mirror** of the things the app must be able to show with no
 * connection at all: the user's own bookings, their profile, and the rate
 * table. The rate table carries its fetch time, because a quote must never be
 * produced from a table older than 24 hours — the app refuses rather than
 * guesses.
 *
 * **An action queue** for driver taps. Accept, arrived, start, complete — each
 * is written locally with *the time it actually happened*, then replayed when
 * the connection returns. A driver in a dead spot at 14:05 who syncs at 14:40
 * produces a record that says 14:05. Getting that wrong corrupts every
 * downstream number: the trip duration, the no-show grace, the night-rate
 * boundary on an evening trip.
 *
 * The one thing that is never queued is **creating a booking**. Spec §14 is
 * explicit: a booking requires a live connection, because an offline booking
 * is one the driver never receives and a passenger who thinks a car is coming.
 */

import * as SQLite from 'expo-sqlite';
import { Timing, isRateTableFresh } from '@wantok/core';

let database = null;

async function db() {
  if (database) return database;
  database = await SQLite.openDatabaseAsync('wantok.db');
  await database.execAsync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY NOT NULL,
      state TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS action_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id TEXT NOT NULL,
      event TEXT NOT NULL,
      payload TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );

    CREATE INDEX IF NOT EXISTS action_queue_order ON action_queue (occurred_at);
  `);
  return database;
}

// ---------------------------------------------------------------------
// Key/value mirror
// ---------------------------------------------------------------------

async function put(key, value) {
  const handle = await db();
  await handle.runAsync(
    'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    key,
    JSON.stringify(value),
    new Date().toISOString(),
  );
}

async function get(key) {
  const handle = await db();
  const row = await handle.getFirstAsync('SELECT value, updated_at FROM kv WHERE key = ?', key);
  if (!row) return null;
  return { value: JSON.parse(row.value), updatedAt: row.updated_at };
}

// ---------------------------------------------------------------------
// Rate table
// ---------------------------------------------------------------------

export async function cacheRates(rates) {
  await put('rates', rates);
}

/**
 * The cached rate table and whether it may still be quoted from.
 *
 * Returns the freshness verdict rather than throwing, so the booking screen
 * can show "we could not refresh prices — try again when you have signal"
 * instead of an error dialog with no way forward.
 */
export async function getCachedRates(now = new Date()) {
  const entry = await get('rates');
  if (!entry) return { rates: null, fresh: false, fetchedAt: null };
  return {
    rates: entry.value,
    fetchedAt: entry.updatedAt,
    fresh: isRateTableFresh(entry.updatedAt, now),
    maxAgeHours: Timing.RATE_TABLE_MAX_AGE_HOURS,
  };
}

export async function cacheProfile(profile) {
  await put('profile', profile);
}

export async function getCachedProfile() {
  return (await get('profile'))?.value ?? null;
}

// ---------------------------------------------------------------------
// Booking mirror
// ---------------------------------------------------------------------

export async function cacheBookings(bookings) {
  const handle = await db();
  await handle.withTransactionAsync(async () => {
    for (const booking of bookings) {
      await handle.runAsync(
        'INSERT INTO bookings (id, state, payload, updated_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET state = excluded.state, payload = excluded.payload, updated_at = excluded.updated_at',
        booking.id,
        booking.state,
        JSON.stringify(booking),
        new Date().toISOString(),
      );
    }
  });
}

export async function getCachedBookings() {
  const handle = await db();
  const rows = await handle.getAllAsync('SELECT payload FROM bookings ORDER BY updated_at DESC');
  return rows.map((r) => JSON.parse(r.payload));
}

export async function getCachedBooking(id) {
  const handle = await db();
  const row = await handle.getFirstAsync('SELECT payload FROM bookings WHERE id = ?', id);
  return row ? JSON.parse(row.payload) : null;
}

// ---------------------------------------------------------------------
// The action queue
// ---------------------------------------------------------------------

/**
 * Record a driver action locally.
 *
 * `occurredAt` defaults to now and should almost never be passed — the point
 * is that it is captured at the tap, not at the upload.
 */
export async function queueAction(bookingId, event, payload = {}, occurredAt = new Date()) {
  const handle = await db();
  await handle.runAsync(
    'INSERT INTO action_queue (booking_id, event, payload, occurred_at) VALUES (?, ?, ?, ?)',
    bookingId,
    event,
    JSON.stringify(payload),
    occurredAt.toISOString(),
  );
}

export async function pendingActions() {
  const handle = await db();
  const rows = await handle.getAllAsync('SELECT * FROM action_queue ORDER BY occurred_at ASC');
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

export async function pendingCount() {
  const handle = await db();
  const row = await handle.getFirstAsync('SELECT COUNT(*) AS n FROM action_queue');
  return row?.n ?? 0;
}

/**
 * Replay the queue in the order things happened.
 *
 * Ordering matters and it is chronological, not insertion order — a handset
 * whose clock jumped, or which recorded an "arrived" before a queued
 * "en route" finished uploading, must still replay the sequence the trip
 * actually took.
 *
 * A rejected action is dropped rather than retried forever. The usual reason
 * is that the state machine has moved on — the passenger cancelled while the
 * driver was in a dead spot — and retrying a transition the server will never
 * accept just blocks everything behind it.
 */
export async function flushQueue(send) {
  const handle = await db();
  const actions = await pendingActions();
  const results = { sent: 0, dropped: 0, failed: 0 };

  for (const action of actions) {
    try {
      await send(action.booking_id, action.event, {
        payload: action.payload,
        occurredAt: new Date(action.occurred_at),
      });
      await handle.runAsync('DELETE FROM action_queue WHERE id = ?', action.id);
      results.sent += 1;
    } catch (error) {
      const rejected = /cannot|illegal|not found|already/i.test(error.message ?? '');
      if (rejected || action.attempts >= 5) {
        await handle.runAsync('DELETE FROM action_queue WHERE id = ?', action.id);
        results.dropped += 1;
      } else {
        await handle.runAsync(
          'UPDATE action_queue SET attempts = attempts + 1, last_error = ? WHERE id = ?',
          String(error.message ?? error),
          action.id,
        );
        results.failed += 1;
        // Stop on the first genuine network failure. Everything behind it is
        // going to fail the same way, and hammering a dead connection costs
        // the driver battery and data.
        break;
      }
    }
  }

  return results;
}

/** Used on sign-out. Leaves nothing of one driver's shift for the next. */
export async function clearAll() {
  const handle = await db();
  await handle.execAsync('DELETE FROM kv; DELETE FROM bookings; DELETE FROM action_queue;');
}
