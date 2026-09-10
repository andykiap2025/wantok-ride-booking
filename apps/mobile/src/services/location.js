/**
 * Location.
 *
 * Two jobs, with very different requirements.
 *
 * **Driver presence** (spec §13): every 15 seconds while online and idle,
 * every 5 during an active trip, and *not at all* when offline. That last
 * clause is not a performance note — a driver who is off shift is entitled to
 * not be tracked, and an app that keeps reporting anyway will be uninstalled
 * and deserve it.
 *
 * **SOS streaming** (spec §10): every 10 seconds for 60 minutes, "regardless
 * of app state". That means a background task, because the phone may well be
 * in a pocket, locked, or thrown on the floor of the vehicle.
 */

import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { Timing } from '@wantok/core';

import { pingLocation, pushBreadcrumbs, streamSosLocation } from './supabase';

export const DRIVER_TASK = 'wantok-driver-location';
export const SOS_TASK = 'wantok-sos-location';

// ---------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------

export async function requestForegroundPermission() {
  const { status } = await Location.requestForegroundPermissionsAsync();
  return status === 'granted';
}

/**
 * Background permission is asked for separately, and only from the driver app,
 * after the driver has understood why. Asking on first launch is how you get
 * denied — and once denied on Android, re-asking is a settings trip.
 */
export async function requestBackgroundPermission() {
  const foreground = await requestForegroundPermission();
  if (!foreground) return false;
  const { status } = await Location.requestBackgroundPermissionsAsync();
  return status === 'granted';
}

export async function getCurrentPosition() {
  const granted = await requestForegroundPermission();
  if (!granted) return null;
  const position = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.Balanced,
  });
  return {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    heading: position.coords.heading,
    accuracy: position.coords.accuracy,
  };
}

// ---------------------------------------------------------------------
// Driver presence
// ---------------------------------------------------------------------

/**
 * Module state for the background task.
 *
 * A TaskManager task is registered once, at module scope, and cannot close
 * over React state — it may run when no component is mounted. So who is
 * driving and what they are doing is kept here and updated by the app.
 */
const presence = {
  driverId: null,
  bookingId: null,
  onTrip: false,
  /** Pings that failed to upload, waiting for coverage (spec §14). */
  buffer: [],
};

TaskManager.defineTask(DRIVER_TASK, async ({ data, error }) => {
  if (error || !data?.locations?.length || !presence.driverId) return;

  const last = data.locations[data.locations.length - 1];
  const point = {
    lat: last.coords.latitude,
    lng: last.coords.longitude,
    heading: last.coords.heading ?? 0,
    recordedAt: new Date(last.timestamp).toISOString(),
  };

  try {
    await pingLocation(presence.driverId, point);

    // On an active trip, every fix is also a breadcrumb — the trail the admin
    // console draws during a dispute, and the one an SOS freezes.
    if (presence.onTrip && presence.bookingId) {
      const batch = [...presence.buffer, point];
      presence.buffer = [];
      await pushBreadcrumbs(presence.bookingId, batch);
    }
  } catch {
    // Out of coverage. Hold on to it — the timestamp is the real one, so a
    // late upload still reconstructs the trip accurately.
    if (presence.onTrip) presence.buffer.push(point);
    // Cap the buffer: a driver in a dead zone for an hour should not fill
    // the device with points nobody will look at.
    if (presence.buffer.length > 500) presence.buffer.splice(0, presence.buffer.length - 500);
  }
});

/** Start reporting. Called when the driver goes online, and never before. */
export async function startPresence(driverId) {
  const granted = await requestBackgroundPermission();
  if (!granted) return false;

  presence.driverId = driverId;
  presence.onTrip = false;

  const alreadyRunning = await Location.hasStartedLocationUpdatesAsync(DRIVER_TASK);
  if (alreadyRunning) await Location.stopLocationUpdatesAsync(DRIVER_TASK);

  await Location.startLocationUpdatesAsync(DRIVER_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: Timing.PING_IDLE_SECONDS * 1000,
    distanceInterval: 25,
    pausesUpdatesAutomatically: false,
    foregroundService: {
      notificationTitle: 'Wantok Ride',
      notificationBody: 'You are online and visible to passengers.',
      notificationColor: '#FCD116',
    },
  });
  return true;
}

/**
 * Tighten the cadence for an active trip: 5 seconds instead of 15.
 *
 * Restarting the task with new options is the documented way to change the
 * interval; there is no live setter.
 */
export async function setTripCadence(bookingId) {
  presence.bookingId = bookingId;
  presence.onTrip = true;
  if (!presence.driverId) return;

  await Location.startLocationUpdatesAsync(DRIVER_TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: Timing.PING_ACTIVE_SECONDS * 1000,
    distanceInterval: 10,
    pausesUpdatesAutomatically: false,
    foregroundService: {
      notificationTitle: 'Wantok Ride — trip in progress',
      notificationBody: 'Sharing your location with the passenger.',
      notificationColor: '#FCD116',
    },
  });
}

export async function clearTripCadence() {
  presence.bookingId = null;
  presence.onTrip = false;
  if (presence.driverId) await startPresence(presence.driverId);
}

/** Going offline stops the reporting completely. */
export async function stopPresence() {
  presence.driverId = null;
  presence.bookingId = null;
  presence.onTrip = false;
  presence.buffer = [];
  if (await Location.hasStartedLocationUpdatesAsync(DRIVER_TASK)) {
    await Location.stopLocationUpdatesAsync(DRIVER_TASK);
  }
}

// ---------------------------------------------------------------------
// SOS streaming
// ---------------------------------------------------------------------

const sos = { id: null, until: 0 };

TaskManager.defineTask(SOS_TASK, async ({ data, error }) => {
  if (error || !data?.locations?.length || !sos.id) return;

  if (Date.now() > sos.until) {
    await stopSosStream();
    return;
  }

  const last = data.locations[data.locations.length - 1];
  try {
    await streamSosLocation(sos.id, {
      lat: last.coords.latitude,
      lng: last.coords.longitude,
    });
  } catch {
    // Nothing useful to do. The next fix is 10 seconds away, and an admin is
    // already on the phone. Never surface an error here — the person who
    // pressed this button has other problems.
  }
});

/**
 * Stream location after an SOS: every 10 seconds for 60 minutes, whatever
 * the app is doing.
 *
 * This runs *alongside* the normal presence task, not instead of it. A driver
 * SOS must not take the vehicle off the passenger's map, and a passenger SOS
 * must not change anything the driver can see (spec §10).
 */
export async function startSosStream(sosId) {
  sos.id = sosId;
  sos.until = Date.now() + Timing.SOS_STREAM_MINUTES * 60_000;

  await Location.startLocationUpdatesAsync(SOS_TASK, {
    accuracy: Location.Accuracy.Highest,
    timeInterval: Timing.SOS_STREAM_SECONDS * 1000,
    distanceInterval: 0,
    pausesUpdatesAutomatically: false,
    foregroundService: {
      // Deliberately bland. A notification reading "EMERGENCY ALERT ACTIVE"
      // on a screen someone else can see is a safety problem of its own.
      notificationTitle: 'Wantok Ride',
      notificationBody: 'Location sharing is on.',
      notificationColor: '#FCD116',
    },
  });
}

export async function stopSosStream() {
  sos.id = null;
  sos.until = 0;
  if (await Location.hasStartedLocationUpdatesAsync(SOS_TASK)) {
    await Location.stopLocationUpdatesAsync(SOS_TASK);
  }
}

/** Restarts an interrupted stream after an app restart, if time remains. */
export async function resumeSosStreamIfActive(sosId, triggeredAt) {
  const until = new Date(triggeredAt).getTime() + Timing.SOS_STREAM_MINUTES * 60_000;
  if (Date.now() >= until) return false;
  await startSosStream(sosId);
  return true;
}
