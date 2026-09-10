/**
 * Google Maps: Directions, Geocoding and Places.
 *
 * Spec §13 is the whole design of this file. Google bills per call and the
 * vehicle list is where that runs away, so every rule it sets is enforced
 * here rather than left to the discipline of whoever writes the next screen:
 *
 *   1. Ordering the vehicle list is haversine, on the handset. It never calls
 *      this file — see `@wantok/core/dispatch`.
 *   2. Directions is called once per booking attempt, for the quoted route.
 *   3. A driver-to-pickup ETA is fetched only when the customer taps a
 *      specific vehicle, never for every row.
 *   4. Routes are cached for 10 minutes, so comparing vehicles is free.
 *   6. Every ETA shown to a user is padded by 30%.
 *
 * Rule 7 — the daily quota alarm — is a Google Cloud console setting, not
 * code. Set it before the first APK goes out.
 */

import { createRouteCache, padEtaSeconds, formatDuration } from '@wantok/core';
import { GOOGLE_MAPS_KEY } from './config';

const DIRECTIONS = 'https://maps.googleapis.com/maps/api/directions/json';
const GEOCODE = 'https://maps.googleapis.com/maps/api/geocode/json';
const PLACES = 'https://maps.googleapis.com/maps/api/place/autocomplete/json';
const PLACE_DETAILS = 'https://maps.googleapis.com/maps/api/place/details/json';

/** Biases Places and Geocoding results to the National Capital District. */
const NCD_BIAS = { lat: -9.4438, lng: 147.1803, radiusMetres: 30000 };

const routeCache = createRouteCache();

/** Counts calls, so the Developer screen can show what a session cost. */
const meter = { directions: 0, geocode: 0, places: 0, cacheHits: 0 };
export const getApiMeter = () => ({ ...meter });

class MapsError extends Error {
  constructor(status, message) {
    super(message || `Google Maps returned ${status}`);
    this.name = 'MapsError';
    this.status = status;
  }
}

async function call(url, params, counter) {
  const query = new URLSearchParams({ ...params, key: GOOGLE_MAPS_KEY });
  const response = await fetch(`${url}?${query}`);
  if (!response.ok) throw new MapsError(response.status, 'Network error talking to Google Maps');

  const body = await response.json();
  meter[counter] += 1;

  if (body.status === 'ZERO_RESULTS') return body;
  if (body.status !== 'OK') {
    // OVER_QUERY_LIMIT and REQUEST_DENIED are the two that will actually
    // happen in production, and they need to be distinguishable in a crash
    // report from "the passenger typed nonsense".
    throw new MapsError(body.status, body.error_message);
  }
  return body;
}

/**
 * The route being quoted: pickup to destination.
 *
 * This is the only call that decides a fare, and it happens once per booking
 * attempt. The 10-minute cache means a customer who opens four vehicles and
 * backs out of three is still one call.
 */
export async function getQuoteRoute(pickup, destination, now = new Date()) {
  const cached = routeCache.get(pickup, destination, now);
  if (cached) {
    meter.cacheHits += 1;
    return { ...cached, cached: true };
  }

  const body = await call(
    DIRECTIONS,
    {
      origin: `${pickup.lat},${pickup.lng}`,
      destination: `${destination.lat},${destination.lng}`,
      mode: 'driving',
      region: 'pg',
    },
    'directions',
  );

  const leg = body.routes?.[0]?.legs?.[0];
  if (!leg) throw new MapsError('NO_ROUTE', 'No road route between those two points');

  const route = {
    distanceKm: Math.round((leg.distance.value / 1000) * 10) / 10,
    seconds: leg.duration.value,
    path: decodePolyline(body.routes[0].overview_polyline.points),
    startAddress: leg.start_address,
    endAddress: leg.end_address,
  };

  routeCache.set(pickup, destination, route, now);
  return { ...route, cached: false };
}

/**
 * How long until this specific vehicle reaches the pickup.
 *
 * Called when the customer taps a vehicle, and not before (rule 3). Ten rows
 * on a list would be ten calls, on every list refresh, for a number most of
 * them will never look at.
 */
export async function getPickupEta(driverPosition, pickup) {
  const body = await call(
    DIRECTIONS,
    {
      origin: `${driverPosition.lat},${driverPosition.lng}`,
      destination: `${pickup.lat},${pickup.lng}`,
      mode: 'driving',
      region: 'pg',
      departure_time: 'now',
    },
    'directions',
  );

  const leg = body.routes?.[0]?.legs?.[0];
  if (!leg) return null;

  const raw = leg.duration_in_traffic?.value ?? leg.duration.value;
  // Rule 6. Google's Port Moresby traffic model is thin, and an ETA that
  // keeps slipping is worse than an honest one.
  const padded = padEtaSeconds(raw);

  return {
    seconds: padded,
    rawSeconds: raw,
    label: formatDuration(padded),
    distanceKm: Math.round((leg.distance.value / 1000) * 10) / 10,
    path: decodePolyline(body.routes[0].overview_polyline.points),
  };
}

/** Turn a dropped map pin into an address the driver can read. */
export async function reverseGeocode({ lat, lng }) {
  const body = await call(GEOCODE, { latlng: `${lat},${lng}`, region: 'pg' }, 'geocode');
  const best = body.results?.[0];
  if (!best) return { label: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, precise: false };

  // Prefer the short name of a suburb or landmark over a full postal address:
  // "Boroko Foodworld" is a better pickup instruction than a street number
  // that may not be signposted.
  const landmark = best.address_components?.find(
    (c) => c.types.includes('point_of_interest') || c.types.includes('establishment'),
  );
  return {
    label: landmark?.long_name ?? best.formatted_address,
    detail: best.formatted_address,
    precise: true,
  };
}

/** Address search, biased hard to NCD. */
export async function searchAddresses(input, sessionToken) {
  if (input.trim().length < 3) return [];
  const body = await call(
    PLACES,
    {
      input,
      components: 'country:pg',
      location: `${NCD_BIAS.lat},${NCD_BIAS.lng}`,
      radius: String(NCD_BIAS.radiusMetres),
      sessiontoken: sessionToken,
    },
    'places',
  );
  return (body.predictions ?? []).map((p) => ({
    placeId: p.place_id,
    name: p.structured_formatting.main_text,
    detail: p.structured_formatting.secondary_text,
  }));
}

/**
 * Resolve a chosen suggestion to coordinates.
 *
 * Passing the same `sessionToken` used for the autocomplete calls is what
 * makes Google bill the whole search as one session rather than per keystroke.
 * It is worth getting right: without it, typing "Vision City" is eleven
 * billable calls instead of one.
 */
export async function getPlaceCoordinates(placeId, sessionToken) {
  const body = await call(
    PLACE_DETAILS,
    { place_id: placeId, fields: 'geometry,name,formatted_address', sessiontoken: sessionToken },
    'places',
  );
  const place = body.result;
  return {
    lat: place.geometry.location.lat,
    lng: place.geometry.location.lng,
    label: place.name,
    detail: place.formatted_address,
  };
}

/** Google's encoded polyline format, unpacked for the map. */
export function decodePolyline(encoded) {
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

export { MapsError };
