/**
 * The map.
 *
 * Raster tiles laid out as plain <Image> views, with an SVG overlay for the
 * route, the pins and the vehicles.
 *
 * Why not `react-native-maps`: under React Native 0.86's New Architecture it
 * mounts but paints nothing — not even its own markers. Rather than pin the
 * whole app to the old architecture for one component, the map is drawn here.
 * Standard Web Mercator tiles, no native module, no key, identical on both
 * platforms, and it works in Expo Go.
 *
 * Tile source: Esri is the one major basemap still serving anonymously with
 * no key and no watermark. The obvious alternatives were checked against Port
 * Moresby directly and both fail as a *valid image* rather than an error,
 * which makes the map look broken rather than throwing:
 *
 *   - CARTO returns 200 with "API KEY REQUIRED" stamped across every tile.
 *   - OpenStreetMap returns 403 for apps that do not meet its usage policy.
 *
 * For production volume, register an ArcGIS location-services key.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, PanResponder, StyleSheet, View } from 'react-native';
import Svg, { Circle, G, Path, Polyline } from 'react-native-svg';

import { colors } from '../theme';

const TILE = 256;

const esri = (service, folder) => (z, x, y) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/${folder ? `${folder}/` : ''}` +
  `${service}/MapServer/tile/${z}/${y}/${x}`;

const SERVICES = {
  imagery: { id: 'imagery', url: esri('World_Imagery') },
  street: { id: 'street', url: esri('World_Street_Map') },
  topo: { id: 'topo', url: esri('World_Topo_Map') },
  roads: { id: 'roads', url: esri('World_Transportation', 'Reference') },
  places: { id: 'places', url: esri('World_Boundaries_and_Places', 'Reference') },
};

/**
 * `hybrid` is the default: imagery with road and place labels composited on
 * top. Port Moresby's settlements are far better represented in imagery than
 * in any vector road map, and a passenger directing a driver to a spot with no
 * street name needs to recognise the ground, not the street grid.
 */
export const MAP_LAYERS = {
  hybrid: { base: SERVICES.imagery, overlays: [SERVICES.roads, SERVICES.places] },
  satellite: { base: SERVICES.imagery, overlays: [] },
  street: { base: SERVICES.street, overlays: [] },
  topo: { base: SERVICES.topo, overlays: [] },
};

const FALLBACK_ORDER = ['hybrid', 'street', 'topo'];

// --- Web Mercator --------------------------------------------------------

const lngToTileX = (lng, z) => ((lng + 180) / 360) * 2 ** z;

const latToTileY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

const tileYToLat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

const tileXToLng = (x, z) => (x / 2 ** z) * 360 - 180;

/** Integer zoom that fits a latitude span into `height` pixels. */
export function zoomFor(span, height) {
  const top = latToTileY(span.lat + span.latDelta / 2, 0);
  const bottom = latToTileY(span.lat - span.latDelta / 2, 0);
  const pixels = Math.abs(bottom - top) * TILE;
  if (!pixels || !Number.isFinite(pixels)) return 13;
  return Math.max(2, Math.min(18, Math.round(Math.log2(height / pixels))));
}

/** lat/lng → pixel, so overlays land exactly on the tiles beneath them. */
export function makeProjection(region, width, height) {
  const z = zoomFor(region, height);
  const originX = lngToTileX(region.lng, z) * TILE - width / 2;
  const originY = latToTileY(region.lat, z) * TILE - height / 2;

  const project = (point) => ({
    x: lngToTileX(point.lng, z) * TILE - originX,
    y: latToTileY(point.lat, z) * TILE - originY,
  });

  project.invert = (x, y) => ({
    lat: tileYToLat((originY + y) / TILE, z),
    lng: tileXToLng((originX + x) / TILE, z),
  });

  project.zoom = z;
  return project;
}

/** A region that fits every point, with room for the pins to breathe. */
export function regionFor(points, pad = 1.7) {
  const valid = points.filter(Boolean);
  if (!valid.length) return { lat: -9.4438, lng: 147.1803, latDelta: 0.06, lngDelta: 0.06 };
  if (valid.length === 1) return { ...valid[0], latDelta: 0.012, lngDelta: 0.012 };

  const lats = valid.map((p) => p.lat);
  const lngs = valid.map((p) => p.lng);
  const latDelta = Math.max((Math.max(...lats) - Math.min(...lats)) * pad, 0.008);
  const lngDelta = Math.max((Math.max(...lngs) - Math.min(...lngs)) * pad, 0.008);

  return {
    lat: (Math.max(...lats) + Math.min(...lats)) / 2,
    lng: (Math.max(...lngs) + Math.min(...lngs)) / 2,
    latDelta,
    lngDelta,
  };
}

// --- Tiles ---------------------------------------------------------------

function TileLayer({ region, width, height, layer }) {
  const [fallback, setFallback] = useState(-1);
  const failures = useRef(0);

  useEffect(() => {
    failures.current = 0;
  }, [fallback, layer]);

  /**
   * Single tiles fail routinely — a gap at the edge of coverage, a flaky
   * request. Only treat it as a dead service after several in a row, then
   * drop to the next look rather than showing an empty rectangle.
   */
  const onTileError = useCallback(() => {
    failures.current += 1;
    if (failures.current >= 5) {
      setFallback((f) => Math.min(f + 1, FALLBACK_ORDER.length - 1));
    }
  }, []);

  const active = MAP_LAYERS[fallback >= 0 ? FALLBACK_ORDER[fallback] : layer] ?? MAP_LAYERS.street;

  const tiles = useMemo(() => {
    if (!width || !height) return [];
    const z = zoomFor(region, height);
    const n = 2 ** z;
    const originX = lngToTileX(region.lng, z) * TILE - width / 2;
    const originY = latToTileY(region.lat, z) * TILE - height / 2;

    const out = [];
    for (let ty = Math.floor(originY / TILE); ty <= Math.floor((originY + height) / TILE); ty += 1) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = Math.floor(originX / TILE); tx <= Math.floor((originX + width) / TILE); tx += 1) {
        const wrapped = ((tx % n) + n) % n;
        out.push({
          key: `${z}/${wrapped}/${ty}`,
          z,
          x: wrapped,
          y: ty,
          left: tx * TILE - originX,
          top: ty * TILE - originY,
        });
      }
    }
    return out;
  }, [region, width, height]);

  if (!width || !height) return null;

  return (
    <View style={styles.fill} pointerEvents="none">
      {[active.base, ...active.overlays].map((service, depth) =>
        tiles.map((t) => (
          <Image
            key={service.id + t.key}
            source={{ uri: service.url(t.z, t.x, t.y) }}
            style={{ position: 'absolute', left: t.left, top: t.top, width: TILE, height: TILE }}
            // Only the base layer's failures count. A missing label tile is
            // not a reason to abandon the imagery underneath it.
            onError={depth === 0 ? onTileError : undefined}
            fadeDuration={depth === 0 ? 120 : 0}
          />
        )),
      )}
    </View>
  );
}

// --- Markers -------------------------------------------------------------

/** A map pin, drawn rather than imported so it can be tinted per use. */
function Pin({ x, y, fill, size = 34 }) {
  const w = size * 0.72;
  return (
    <G x={x - w / 2} y={y - size}>
      <Path
        d={`M ${w / 2} ${size} C ${w / 2} ${size} 0 ${size * 0.62} 0 ${w / 2}
            a ${w / 2} ${w / 2} 0 1 1 ${w} 0 c 0 ${size * 0.2} -${w / 2} ${size * 0.38} -${w / 2} ${size} z`}
        fill={fill}
        stroke={colors.white}
        strokeWidth={2}
      />
      <Circle cx={w / 2} cy={w / 2} r={w * 0.22} fill={colors.white} />
    </G>
  );
}

/** A vehicle on the map, rotated to its heading. */
function Car({ x, y, heading = 0, active }) {
  return (
    <G x={x} y={y} rotation={heading} origin={`${x}, ${y}`}>
      <Circle cx={0} cy={0} r={14} fill={active ? colors.gold : colors.white} opacity={0.95} />
      <Circle cx={0} cy={0} r={14} fill="none" stroke={colors.ink} strokeWidth={1.5} />
      <Path
        d="M -5 5 L -5 -3 L -3 -6 L 3 -6 L 5 -3 L 5 5 L 3 5 L 3 3 L -3 3 L -3 5 Z"
        fill={colors.ink}
      />
    </G>
  );
}

// --- The map ------------------------------------------------------------

/**
 * @param region      { lat, lng, latDelta, lngDelta }
 * @param route       polyline of { lat, lng }
 * @param pickup      { lat, lng }
 * @param destination { lat, lng }
 * @param vehicles    [{ id, lat, lng, heading, active }]
 * @param draggable   pan to choose a point; fires onRegionChange
 */
export default function Map({
  region,
  route,
  pickup,
  destination,
  vehicles = [],
  layer = 'hybrid',
  draggable = false,
  onRegionChange,
  style,
  children,
}) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const dragRef = useRef({ x: 0, y: 0 });

  // Panning moves the region, but recomputing the tile grid on every frame
  // is far too slow. Instead the whole layer is translated during the drag
  // and the region is committed once, on release.
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => draggable,
        onMoveShouldSetPanResponder: (_, g) => draggable && (Math.abs(g.dx) > 3 || Math.abs(g.dy) > 3),
        onPanResponderMove: (_, g) => setDrag({ x: g.dx, y: g.dy }),
        onPanResponderRelease: (_, g) => {
          setDrag({ x: 0, y: 0 });
          if (!size.width || !onRegionChange) return;
          const projection = makeProjection(region, size.width, size.height);
          const centre = projection.invert(size.width / 2 - g.dx, size.height / 2 - g.dy);
          onRegionChange({ ...region, ...centre });
        },
      }),
    [draggable, region, size, onRegionChange],
  );

  useEffect(() => {
    dragRef.current = drag;
  }, [drag]);

  const projection = useMemo(
    () => (size.width ? makeProjection(region, size.width, size.height) : null),
    [region, size],
  );

  return (
    <View
      style={[styles.container, style]}
      onLayout={(e) => setSize(e.nativeEvent.layout)}
      {...panResponder.panHandlers}
    >
      <View style={[styles.fill, { transform: [{ translateX: drag.x }, { translateY: drag.y }] }]}>
        <TileLayer region={region} width={size.width} height={size.height} layer={layer} />

        {projection && size.width > 0 && (
          <Svg width={size.width} height={size.height} style={styles.fill} pointerEvents="none">
            {route?.length > 1 && (
              <>
                {/* A dark casing under the line, so a bright green route stays
                    legible over pale sand and rooftops. */}
                <Polyline
                  points={route.map((p) => { const q = projection(p); return `${q.x},${q.y}`; }).join(' ')}
                  fill="none"
                  stroke={colors.ink}
                  strokeWidth={7}
                  strokeOpacity={0.35}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <Polyline
                  points={route.map((p) => { const q = projection(p); return `${q.x},${q.y}`; }).join(' ')}
                  fill="none"
                  stroke={colors.route}
                  strokeWidth={4}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </>
            )}

            {vehicles.map((v) => {
              const q = projection(v);
              return <Car key={v.id} x={q.x} y={q.y} heading={v.heading} active={v.active} />;
            })}

            {pickup && (() => {
              const q = projection(pickup);
              return <Pin x={q.x} y={q.y} fill={colors.ink} />;
            })()}

            {destination && (() => {
              const q = projection(destination);
              return <Pin x={q.x} y={q.y} fill={colors.gold} />;
            })()}
          </Svg>
        )}
      </View>

      {/* A fixed centre pin for pick-on-map: the map moves under it, which is
          steadier on a bad GPS fix than dragging a pin around. */}
      {draggable && (
        <View style={styles.centrePin} pointerEvents="none">
          <Svg width={40} height={44}>
            <Pin x={20} y={40} fill={colors.ink} size={38} />
          </Svg>
        </View>
      )}

      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { overflow: 'hidden', backgroundColor: colors.surfaceAlt },
  fill: { ...StyleSheet.absoluteFillObject },
  centrePin: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
