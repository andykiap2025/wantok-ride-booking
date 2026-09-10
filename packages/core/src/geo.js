/**
 * Geometry that costs nothing.
 *
 * Spec §13 is blunt about this: the vehicle list is ordered by straight-line
 * distance computed on the handset, because ordering ten vehicles with the
 * Directions API would bill ten calls to draw one screen. Google is called
 * once, for the route the customer is actually quoting.
 */

import { Thresholds } from './constants.js';

const EARTH_RADIUS_KM = 6371.0088;
const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/** Great-circle distance in kilometres between two {lat, lng} points. */
export function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** Compass bearing a→b in degrees, for pointing the car icon the right way. */
export function bearingDeg(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Pad a provider ETA (spec §13, rule 6).
 *
 * Google's traffic model for Port Moresby is thin, and an optimistic ETA that
 * keeps slipping annoys a passenger far more than an honest one that lands
 * early. Everything shown to a user goes through here.
 */
export function padEtaSeconds(seconds, fraction = Thresholds.ETA_PAD_FRACTION) {
  return Math.ceil(seconds * (1 + fraction));
}

/** "4 min", "1 hr 10 min". Never "0 min" — the floor is 1. */
export function formatDuration(seconds) {
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hrs} hr ${rem} min` : `${hrs} hr`;
}

/** "800 m" under a kilometre, "4.2 km" over it. */
export function formatDistanceKm(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

/** Bounding box of a set of points, padded by a fraction of its own span. */
export function boundsOf(points, pad = 0.15) {
  if (!points.length) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  // A single point has zero span; give it something to breathe in.
  const latPad = Math.max((maxLat - minLat) * pad, 0.004);
  const lngPad = Math.max((maxLng - minLng) * pad, 0.004);
  return {
    minLat: minLat - latPad,
    maxLat: maxLat + latPad,
    minLng: minLng - lngPad,
    maxLng: maxLng + lngPad,
  };
}

/** Point `t` of the way (0..1) along a polyline, for animating a car. */
export function pointAlong(path, t) {
  if (path.length === 0) return null;
  if (path.length === 1) return path[0];
  const clamped = Math.min(1, Math.max(0, t));

  const legs = [];
  let total = 0;
  for (let i = 1; i < path.length; i += 1) {
    const d = haversineKm(path[i - 1], path[i]);
    legs.push(d);
    total += d;
  }
  if (total === 0) return path[0];

  let travelled = clamped * total;
  for (let i = 0; i < legs.length; i += 1) {
    if (travelled <= legs[i] || i === legs.length - 1) {
      const f = legs[i] === 0 ? 0 : travelled / legs[i];
      const a = path[i];
      const b = path[i + 1];
      return {
        lat: a.lat + (b.lat - a.lat) * f,
        lng: a.lng + (b.lng - a.lng) * f,
      };
    }
    travelled -= legs[i];
  }
  return path[path.length - 1];
}
