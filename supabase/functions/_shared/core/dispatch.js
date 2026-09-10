// GENERATED FILE — DO NOT EDIT.
// Copied from packages/core/src by `npm run sync:core`.
// Edit the original; this copy exists only so Supabase can deploy it.

/**
 * The available-vehicle list (spec §7 and §13).
 *
 * There is no dispatch algorithm in Wantok Ride. The customer picks. This file
 * builds the list they pick from, and its whole job is to be *cheap* and
 * *honest*: cheap because Google bills per call and the list screen is where
 * that runs away, honest because a vehicle on the list that cannot actually
 * come is worse than a shorter list.
 *
 * Cost discipline, straight from §13:
 *   - order by haversine, computed on the handset — zero API cost
 *   - one Directions call per booking attempt, for the quoted route
 *   - a driver-to-pickup ETA only when the customer taps a specific vehicle
 *   - cap the list at ten
 */

import { Thresholds, Timing } from './constants.js';
import { haversineKm } from './geo.js';
import { isListable } from './ledger.js';
import { quote } from './fare.js';

/**
 * Has this driver reported recently enough to be shown?
 *
 * Ten minutes. A stale pin is the fastest way to lose a customer: they pick
 * the nearest car, it never responds, and they conclude the app does not work.
 */
export function isPresenceFresh(presence, now = new Date()) {
  if (!presence?.is_online || !presence.last_ping_at) return false;
  const age = now.getTime() - new Date(presence.last_ping_at).getTime();
  return age <= Timing.PRESENCE_STALE_MINUTES * 60_000;
}

/**
 * Build the list the customer chooses from.
 *
 * `excludeVehicleIds` carries the vehicles that have already declined or timed
 * out on this booking attempt. Spec §7: the customer goes back to the list
 * with that vehicle removed and the fare still held.
 */
export function availableVehicles({
  vehicles,
  presence,
  rates,
  pickup,
  distanceKm,
  startAt = new Date(),
  seatsNeeded = 1,
  excludeVehicleIds = [],
  now = new Date(),
  limit = Thresholds.MAX_VEHICLES_LISTED,
}) {
  const presenceById = new Map(presence.map((p) => [p.vehicle_id, p]));
  const excluded = new Set(excludeVehicleIds);
  const ratesByClass = new Map(rates.map((r) => [r.classCode, r]));

  return vehicles
    .filter((v) => !excluded.has(v.id))
    .filter((v) => isListable(v, now))
    .filter((v) => v.seats >= seatsNeeded)
    .filter((v) => isPresenceFresh(presenceById.get(v.id), now))
    .filter((v) => ratesByClass.has(v.class_code))
    .map((v) => {
      const p = presenceById.get(v.id);
      const q = quote({ rate: ratesByClass.get(v.class_code), distanceKm, startAt });
      return {
        vehicle: v,
        presence: p,
        // Straight-line, not driving distance. Shown as "2.1 km away", never
        // as an ETA — an ETA implies a route nobody has paid Google to compute.
        straightLineKm: haversineKm(pickup, { lat: p.lat, lng: p.lng }),
        quote: q,
      };
    })
    .sort((a, b) => a.straightLineKm - b.straightLineKm)
    .slice(0, limit);
}

/**
 * Remove a vehicle after a decline or timeout, keeping the locked fare.
 *
 * The fare travels with the booking attempt, not with the vehicle, so picking
 * a second car of the same class re-quotes to the same number and the customer
 * does not feel the price move under them.
 */
export function withoutVehicle(list, vehicleId) {
  return list.filter((row) => row.vehicle.id !== vehicleId);
}

/**
 * A route cache key and its freshness test (spec §13, rule 4).
 *
 * Ten minutes of the same pickup and destination is one Directions call, no
 * matter how many vehicles the customer opens and backs out of.
 */
export function routeCacheKey(pickup, destination) {
  const r = (n) => n.toFixed(4); // ~11 m — finer than anyone taps
  return `${r(pickup.lat)},${r(pickup.lng)}>${r(destination.lat)},${r(destination.lng)}`;
}

export function isRouteCacheFresh(entry, now = new Date()) {
  if (!entry?.fetchedAt) return false;
  return now.getTime() - new Date(entry.fetchedAt).getTime() < Timing.ROUTE_CACHE_MINUTES * 60_000;
}

/**
 * A small in-memory route cache. The app hands this to its maps service, so
 * the billing rule lives with the rule it enforces rather than in a component.
 */
export function createRouteCache() {
  const store = new Map();
  return {
    get(pickup, destination, now = new Date()) {
      const entry = store.get(routeCacheKey(pickup, destination));
      return isRouteCacheFresh(entry, now) ? entry.route : null;
    },
    set(pickup, destination, route, now = new Date()) {
      store.set(routeCacheKey(pickup, destination), {
        route,
        fetchedAt: now.toISOString(),
      });
      return route;
    },
    get size() {
      return store.size;
    },
    clear: () => store.clear(),
  };
}

/**
 * Why a customer's list came back empty.
 *
 * "No vehicles" is a dead end. Knowing whether the problem is the hour, the
 * seat count or the fact that nobody is online in Gerehu at 03:00 is the
 * difference between a user who waits ten minutes and one who deletes the app —
 * and it is the report that tells the operator which corridor to recruit in.
 */
export function explainEmptyList({ vehicles, presence, seatsNeeded, now = new Date() }) {
  const presenceById = new Map(presence.map((p) => [p.vehicle_id, p]));
  const approved = vehicles.filter((v) => isListable(v, now));

  if (!approved.length) {
    return { code: 'NONE_APPROVED', message: 'No vehicles are available in your area yet' };
  }
  const bigEnough = approved.filter((v) => v.seats >= seatsNeeded);
  if (!bigEnough.length) {
    return {
      code: 'SEATS',
      message: `No vehicle with ${seatsNeeded} seats is available right now`,
      suggestion: 'Try fewer passengers, or book two vehicles',
    };
  }
  const online = bigEnough.filter((v) => isPresenceFresh(presenceById.get(v.id), now));
  if (!online.length) {
    return {
      code: 'NONE_ONLINE',
      message: 'No drivers are online right now',
      suggestion: 'Try again shortly, or schedule a ride for later',
    };
  }
  return { code: 'UNKNOWN', message: 'No vehicles available right now' };
}
