/**
 * The live fleet map.
 *
 * Spec §17 lists "watch the live board" as a daily duty. A table tells you
 * what is happening; a map tells you *where*, which is the question an
 * operator actually has — is anyone covering Gerehu tonight, why has that car
 * not moved in twenty minutes, is the airport run going the long way round.
 *
 * Google Maps JS API here rather than the raster tiles the phone apps use.
 * The reason is not preference: `react-native-maps` paints nothing under RN
 * 0.86's New Architecture, which is why the handset draws its own map. A
 * browser has no such problem, and the console gets traffic layers, proper
 * labels and smooth panning for free.
 *
 * What each colour means, and why:
 *
 *   gold    idle and available — a vehicle a passenger could book right now
 *   blue    on the way to a pickup
 *   amber   waiting at the pickup, with the ten-minute no-show clock running
 *   green   passenger on board
 *   grey    online but not reporting — see below
 *
 * That last one matters most. Spec §13 drops a vehicle off the customer list
 * after ten minutes without a ping, but the console keeps showing it, greyed,
 * because a car that goes quiet *mid-trip* is the single thing on this screen
 * worth interrupting someone about.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { formatKina } from '@wantok/core';
import * as api from '../api';

/** Port Moresby. The console opens here before any vehicle has reported. */
const POM = { lat: -9.4438, lng: 147.1803 };

const STATE_STYLE = {
  IDLE: { fill: '#FCD116', label: 'Available', z: 1 },
  CONFIRMED: { fill: '#0E6BA8', label: 'Confirmed', z: 3 },
  DRIVER_EN_ROUTE: { fill: '#0E6BA8', label: 'On the way to pickup', z: 4 },
  ARRIVED: { fill: '#C77700', label: 'Waiting at pickup', z: 5 },
  IN_PROGRESS: { fill: '#1B8F4A', label: 'Passenger on board', z: 6 },
  STALE: { fill: '#8794A1', label: 'Not reporting', z: 2 },
};

/**
 * Load the Google Maps JS API once, for the life of the page.
 *
 * The script tag is shared across every mount — loading it twice logs a
 * console warning and quietly breaks the second map.
 */
let mapsPromise = null;
function loadGoogleMaps(key) {
  if (mapsPromise) return mapsPromise;
  mapsPromise = new Promise((resolve, reject) => {
    if (window.google?.maps) {
      resolve(window.google.maps);
      return;
    }
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=marker&loading=async`;
    script.async = true;
    script.onload = () => resolve(window.google.maps);
    script.onerror = () => reject(new Error('Google Maps failed to load'));
    document.head.appendChild(script);
  });
  return mapsPromise;
}

export default function LiveMap({ onSelect }) {
  const key = import.meta.env.VITE_GOOGLE_MAPS_KEY;
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(new Map());
  const tripLayersRef = useRef(new Map());
  const hasFittedRef = useRef(false);

  const [fleet, setFleet] = useState([]);
  const [unreported, setUnreported] = useState([]);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);
  const [follow, setFollow] = useState(true);

  // --- Data ------------------------------------------------------------

  const load = useCallback(async () => {
    try {
      const { fleet: rows, unreported: missing } = await api.getLiveFleet();
      setFleet(rows);
      setUnreported(missing);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();

    // Realtime moves the pins; the poll is a safety net that also refreshes
    // booking state, which arrives on a different channel.
    const unwatch = api.watchFleet((row) => {
      if (!row?.lat) return;
      setFleet((current) =>
        current.map((v) =>
          v.driver_id === row.driver_id
            ? { ...v, lat: row.lat, lng: row.lng, heading: row.heading, last_ping_at: row.last_ping_at, ageSeconds: 0, stale: false }
            : v,
        ),
      );
    });

    const timer = setInterval(load, 15_000);
    return () => {
      unwatch();
      clearInterval(timer);
    };
  }, [load]);

  // Re-evaluate staleness on a clock, so a vehicle that stops reporting goes
  // grey on its own rather than only when something else forces a re-render.
  useEffect(() => {
    const timer = setInterval(() => {
      setFleet((current) =>
        current.map((v) => {
          const age = (Date.now() - new Date(v.last_ping_at).getTime()) / 1000;
          return { ...v, ageSeconds: age, stale: age > 600 };
        }),
      );
    }, 10_000);
    return () => clearInterval(timer);
  }, []);

  // --- Map -------------------------------------------------------------

  useEffect(() => {
    if (!key) {
      setError('VITE_GOOGLE_MAPS_KEY is not set — the map cannot load.');
      return;
    }
    let cancelled = false;

    loadGoogleMaps(key)
      .then((maps) => {
        if (cancelled || !containerRef.current || mapRef.current) return;
        mapRef.current = new maps.Map(containerRef.current, {
          center: POM,
          zoom: 12,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          clickableIcons: false,
          // Quiet the basemap so the fleet is the only thing that reads
          // brightly. A console is looked at for eight hours a day.
          styles: [
            { featureType: 'poi', stylers: [{ visibility: 'off' }] },
            { featureType: 'transit', stylers: [{ visibility: 'off' }] },
            { featureType: 'road', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
          ],
        });
      })
      .catch((e) => !cancelled && setError(e.message));

    return () => {
      cancelled = true;
    };
  }, [key]);

  const statusOf = useCallback((v) => {
    if (v.stale) return 'STALE';
    return v.booking?.state ?? 'IDLE';
  }, []);

  // --- Markers ---------------------------------------------------------

  useEffect(() => {
    const maps = window.google?.maps;
    const map = mapRef.current;
    if (!maps || !map) return;

    const seen = new Set();

    for (const v of fleet) {
      seen.add(v.driver_id);
      const style = STATE_STYLE[statusOf(v)] ?? STATE_STYLE.IDLE;
      const position = { lat: v.lat, lng: v.lng };

      let marker = markersRef.current.get(v.driver_id);
      if (!marker) {
        marker = new maps.Marker({
          map,
          title: v.vehicle?.registration_no ?? 'Vehicle',
        });
        marker.addListener('click', () => {
          setSelected(v.driver_id);
          onSelect?.(v);
        });
        markersRef.current.set(v.driver_id, marker);
      }

      marker.setPosition(position);
      marker.setZIndex(style.z);
      marker.setIcon({
        path: maps.SymbolPath.FORWARD_CLOSED_ARROW,
        scale: v.booking ? 6 : 5,
        fillColor: style.fill,
        fillOpacity: v.stale ? 0.5 : 1,
        strokeColor: '#141A21',
        strokeWeight: 1.5,
        // A heading of 0 from a stationary vehicle is not north, it is "no
        // reading" — point those up rather than pretending to know.
        rotation: v.heading ?? 0,
      });
      marker.setLabel({
        text: v.vehicle?.registration_no ?? '',
        fontSize: '10px',
        fontWeight: '700',
        color: '#141A21',
        className: 'map-plate',
      });
    }

    // Drop anything that has gone offline.
    for (const [id, marker] of markersRef.current) {
      if (!seen.has(id)) {
        marker.setMap(null);
        markersRef.current.delete(id);
      }
    }
  }, [fleet, statusOf, onSelect]);

  // --- Trip overlays ---------------------------------------------------
  //
  // For a vehicle carrying a booking, draw where it is going: a pin at the
  // pickup or the destination, and a straight line to it. Deliberately a
  // straight line and not a route — a Directions call per active trip, every
  // fifteen seconds, would be a bill nobody sanctioned, and the operator's
  // question is "roughly where is this heading", not "by which streets".

  useEffect(() => {
    const maps = window.google?.maps;
    const map = mapRef.current;
    if (!maps || !map) return;

    const seen = new Set();

    for (const v of fleet) {
      if (!v.booking) continue;
      seen.add(v.booking.id);

      const heading =
        v.booking.state === 'IN_PROGRESS'
          ? { lat: v.booking.dest_lat, lng: v.booking.dest_lng, kind: 'destination' }
          : { lat: v.booking.pickup_lat, lng: v.booking.pickup_lng, kind: 'pickup' };

      let layer = tripLayersRef.current.get(v.booking.id);
      if (!layer) {
        layer = {
          line: new maps.Polyline({
            map,
            geodesic: true,
            strokeOpacity: 0,
            // A dotted leader rather than a solid route line, so nobody reads
            // it as the road the vehicle is actually taking.
            icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.7, scale: 3 }, offset: '0', repeat: '12px' }],
          }),
          pin: new maps.Marker({ map }),
        };
        tripLayersRef.current.set(v.booking.id, layer);
      }

      const colour = heading.kind === 'destination' ? '#1B8F4A' : '#0E6BA8';
      layer.line.setPath([{ lat: v.lat, lng: v.lng }, { lat: heading.lat, lng: heading.lng }]);
      layer.line.setOptions({
        icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.75, strokeColor: colour, scale: 3 }, offset: '0', repeat: '12px' }],
      });
      layer.pin.setPosition({ lat: heading.lat, lng: heading.lng });
      layer.pin.setIcon({
        path: maps.SymbolPath.CIRCLE,
        scale: 6,
        fillColor: colour,
        fillOpacity: 1,
        strokeColor: '#FFFFFF',
        strokeWeight: 2,
      });
      layer.pin.setTitle(
        heading.kind === 'destination' ? v.booking.dest_label : v.booking.pickup_label,
      );
    }

    for (const [id, layer] of tripLayersRef.current) {
      if (!seen.has(id)) {
        layer.line.setMap(null);
        layer.pin.setMap(null);
        tripLayersRef.current.delete(id);
      }
    }
  }, [fleet]);

  // Fit once on first data, then leave the operator's pan and zoom alone
  // unless they ask to re-centre. A map that jumps every fifteen seconds is
  // unusable for the thing it exists to do.
  useEffect(() => {
    const maps = window.google?.maps;
    const map = mapRef.current;
    if (!maps || !map || !fleet.length) return;
    if (hasFittedRef.current && !follow) return;

    const bounds = new maps.LatLngBounds();
    fleet.forEach((v) => bounds.extend({ lat: v.lat, lng: v.lng }));
    map.fitBounds(bounds, 64);
    hasFittedRef.current = true;
    setFollow(false);
  }, [fleet, follow]);

  // --- Counts -----------------------------------------------------------

  const counts = useMemo(() => {
    const out = { IDLE: 0, CONFIRMED: 0, DRIVER_EN_ROUTE: 0, ARRIVED: 0, IN_PROGRESS: 0, STALE: 0 };
    fleet.forEach((v) => {
      out[statusOf(v)] = (out[statusOf(v)] ?? 0) + 1;
    });
    return out;
  }, [fleet, statusOf]);

  const chosen = fleet.find((v) => v.driver_id === selected) ?? null;

  return (
    <div className="card flush live-map-card">
      <div className="live-map-head">
        <div className="live-map-legend">
          {Object.entries(STATE_STYLE)
            .filter(([k]) => counts[k])
            .map(([k, style]) => (
              <span key={k} className="legend-item">
                <span className="legend-dot" style={{ background: style.fill }} />
                {style.label} <strong>{counts[k]}</strong>
              </span>
            ))}
          {!fleet.length ? <span className="muted small">No vehicles online</span> : null}
        </div>
        <button className="btn ghost small" onClick={() => setFollow(true)}>
          Fit to fleet
        </button>
      </div>

      {error ? <div className="blocker" style={{ margin: 14 }}>{error}</div> : null}

      <div ref={containerRef} className="live-map" />

      {unreported.length ? (
        <div className="live-map-warn">
          {unreported.length} active trip{unreported.length > 1 ? 's have' : ' has'} a vehicle that is
          not reporting its position: {unreported.map((b) => b.reference).join(', ')}
        </div>
      ) : null}

      {chosen ? (
        <div className="live-map-detail">
          <div className="live-map-detail-head">
            <div>
              <strong className="mono">{chosen.vehicle?.registration_no}</strong>{' '}
              <span className="muted small">
                {chosen.vehicle?.colour} {chosen.vehicle?.make} {chosen.vehicle?.model}
              </span>
            </div>
            <button className="btn ghost small" onClick={() => setSelected(null)}>Close</button>
          </div>

          <div className="live-map-detail-grid">
            <Fact label="Driver" value={chosen.driverName} phone={chosen.driverPhone} />
            <Fact
              label="Status"
              value={(STATE_STYLE[statusOf(chosen)] ?? STATE_STYLE.IDLE).label}
            />
            <Fact
              label="Last ping"
              value={
                chosen.ageSeconds < 60
                  ? `${Math.round(chosen.ageSeconds)}s ago`
                  : `${Math.floor(chosen.ageSeconds / 60)} min ago`
              }
            />
            {chosen.booking ? (
              <>
                <Fact
                  label="Passenger"
                  value={chosen.booking.profiles?.full_name}
                  phone={chosen.booking.profiles?.phone}
                />
                <Fact label="Booking" value={chosen.booking.reference} />
                <Fact label="Fare" value={formatKina(chosen.booking.quoted_fare)} />
                <Fact
                  label="Route"
                  value={`${chosen.booking.pickup_label} → ${chosen.booking.dest_label}`}
                  wide
                />
              </>
            ) : (
              <Fact label="Booking" value="Idle — available to passengers" wide />
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Fact({ label, value, phone, wide }) {
  return (
    <div style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <div className="small muted">{label}</div>
      <div style={{ fontWeight: 600 }}>
        {value ?? '—'}
        {phone ? (
          <a className="small" href={`tel:${phone}`} style={{ marginLeft: 8, fontWeight: 500 }}>
            {phone}
          </a>
        ) : null}
      </div>
    </div>
  );
}
