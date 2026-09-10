/**
 * Port Moresby places.
 *
 * Real NCD suburbs and landmarks with real coordinates, because a search box
 * that offers "University of Washington" is the fastest way to tell a user
 * this app was not built for them. Ordered roughly by how often someone would
 * actually type them.
 */

export const PLACES = [
  { id: 'boroko', name: 'Boroko', detail: 'Boroko Foodworld, Tabari Place', lat: -9.4638, lng: 147.1878 },
  { id: 'waigani', name: 'Waigani', detail: 'Government offices, Vision City', lat: -9.4239, lng: 147.1801 },
  { id: 'visioncity', name: 'Vision City Mega Mall', detail: 'Waigani Drive', lat: -9.4166, lng: 147.1848 },
  { id: 'airport', name: 'Jacksons International Airport', detail: '7 Mile', lat: -9.4432, lng: 147.2196 },
  { id: 'gordons', name: 'Gordons', detail: 'Gordons Market, Spring Garden Road', lat: -9.4419, lng: 147.1889 },
  { id: 'gerehu', name: 'Gerehu', detail: 'Gerehu Stage 1–6', lat: -9.3776, lng: 147.1394 },
  { id: 'elabeach', name: 'Ela Beach', detail: 'Downtown, Ela Beach Road', lat: -9.4795, lng: 147.1543 },
  { id: 'town', name: 'Town (Downtown)', detail: 'Douglas Street, Champion Parade', lat: -9.4780, lng: 147.1494 },
  { id: 'koki', name: 'Koki', detail: 'Koki Fish Market', lat: -9.4869, lng: 147.1682 },
  { id: 'hohola', name: 'Hohola', detail: 'Hohola, Tokarara Road', lat: -9.4405, lng: 147.1704 },
  { id: 'korobosea', name: 'Korobosea', detail: 'Korobosea, Sir Hubert Murray Hwy', lat: -9.4771, lng: 147.1854 },
  { id: 'sixmile', name: '6 Mile', detail: 'Hubert Murray Highway', lat: -9.4592, lng: 147.2036 },
  { id: 'ninemile', name: '9 Mile', detail: 'Bomana, Hubert Murray Highway', lat: -9.4055, lng: 147.2440 },
  { id: 'konedobu', name: 'Konedobu', detail: 'Kone, Lawes Road', lat: -9.4658, lng: 147.1489 },
  { id: 'tokarara', name: 'Tokarara', detail: 'Tokarara, Morea Tobo Road', lat: -9.4297, lng: 147.1568 },
  { id: 'morata', name: 'Morata', detail: 'Morata 1 and 2', lat: -9.4008, lng: 147.1531 },
  { id: 'pom_gen', name: 'Port Moresby General Hospital', detail: 'Taurama Road, 3 Mile', lat: -9.4713, lng: 147.1932 },
  { id: 'unipng', name: 'University of PNG', detail: 'Waigani Campus', lat: -9.4075, lng: 147.1620 },
  { id: 'taurama', name: 'Taurama', detail: 'Taurama Road, Korobosea', lat: -9.4900, lng: 147.2071 },
  { id: 'harbourcity', name: 'Harbourside', detail: 'Stanley Esplanade, Downtown', lat: -9.4820, lng: 147.1451 },
];

/** The map opens here when a customer has no location fix yet. */
export const POM_CENTRE = { lat: -9.4438, lng: 147.1803 };

export function findPlace(id) {
  return PLACES.find((p) => p.id === id) ?? null;
}

export function searchPlaces(query) {
  const q = query.trim().toLowerCase();
  if (!q) return PLACES;
  return PLACES.filter(
    (p) => p.name.toLowerCase().includes(q) || p.detail.toLowerCase().includes(q),
  );
}

/**
 * A believable driving route between two points.
 *
 * The real app calls the Directions API here (once per booking attempt, and
 * only for the route being quoted — spec §13). This bends the straight line
 * through a couple of waypoints so the polyline on the map does not look like
 * a ruler, and pads the distance by the ~25% that Port Moresby's road layout
 * actually costs you over a crow-flies measurement.
 */
export function mockRoute(from, to) {
  const points = [];
  const steps = 24;
  // Two offset waypoints, deterministic from the endpoints so the same trip
  // always draws the same line.
  const wobble = ((from.lat * 1000) % 1) * 0.004 + 0.002;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const bend = Math.sin(t * Math.PI) * wobble;
    points.push({
      lat: from.lat + (to.lat - from.lat) * t + bend,
      lng: from.lng + (to.lng - from.lng) * t - bend * 0.6,
    });
  }
  return points;
}
