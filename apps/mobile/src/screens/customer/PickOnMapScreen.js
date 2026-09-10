/**
 * Pick a point on the map (design kit screen 19).
 *
 * The pin is fixed to the centre of the screen and the map moves underneath
 * it. That is steadier than dragging a pin around — especially one-handed, on
 * a bad GPS fix — and it means the point being chosen is always in the middle
 * of the screen rather than under a thumb.
 *
 * Reverse geocoding is debounced and only fires when the map settles, because
 * every call costs money and nobody needs an address for a point they are
 * still panning past. It prefers a landmark name over a postal address:
 * "Boroko Foodworld" is a better pickup instruction than a street number that
 * may not be signposted.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import Map from '../../components/Map';
import { Screen, ScreenHeader, FloatingCard } from '../../components/Chrome';
import Button from '../../components/Button';
import { POM_CENTRE } from '../../data/places';
import { getCurrentPosition } from '../../services/location';
import { reverseGeocode } from '../../services/maps';
import { useBookingFlow } from '../../state/BookingFlow';
import { colors, spacing, type } from '../../theme';

export default function PickOnMapScreen({ navigation, route }) {
  const target = route.params?.target ?? 'destination';
  const flow = useBookingFlow();
  const insets = useSafeAreaInsets();

  const existing = target === 'pickup' ? flow.pickup : flow.destination;
  const [region, setRegion] = useState({
    lat: existing?.lat ?? flow.pickup?.lat ?? POM_CENTRE.lat,
    lng: existing?.lng ?? flow.pickup?.lng ?? POM_CENTRE.lng,
    latDelta: 0.01,
    lngDelta: 0.01,
  });
  const [label, setLabel] = useState(existing?.label ?? null);
  const [resolving, setResolving] = useState(false);
  const debounce = useRef(null);

  /** Name the point, but only once the map has stopped moving. */
  const resolve = useCallback((next) => {
    if (debounce.current) clearTimeout(debounce.current);
    setResolving(true);
    debounce.current = setTimeout(async () => {
      try {
        const place = await reverseGeocode(next);
        setLabel(place.label);
      } catch {
        setLabel(`${next.lat.toFixed(5)}, ${next.lng.toFixed(5)}`);
      } finally {
        setResolving(false);
      }
    }, 600);
  }, []);

  useEffect(() => {
    if (!label) resolve(region);
    return () => clearTimeout(debounce.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onRegionChange = (next) => {
    setRegion(next);
    resolve(next);
  };

  const recentre = async () => {
    const position = await getCurrentPosition();
    if (position) {
      const next = { ...region, lat: position.lat, lng: position.lng };
      setRegion(next);
      resolve(next);
    }
  };

  const confirm = () => {
    const value = { lat: region.lat, lng: region.lng, label: label ?? 'Dropped pin' };
    if (target === 'pickup') {
      flow.setPickup(value);
      navigation.goBack();
    } else {
      flow.setDestination(value);
      navigation.navigate('Vehicles');
    }
  };

  return (
    <Screen edges={['top']}>
      <ScreenHeader
        title={target === 'pickup' ? 'Set your pick-up' : 'Set your destination'}
        onBack={navigation.goBack}
      />

      <View style={styles.mapWrap}>
        <Map region={region} draggable onRegionChange={onRegionChange} style={StyleSheet.absoluteFill} />

        <View style={styles.recentreSlot}>
          <Button
            label=""
            icon="locate"
            variant="secondary"
            small
            full={false}
            onPress={recentre}
            style={styles.recentre}
          />
        </View>
      </View>

      <FloatingCard style={[styles.card, { paddingBottom: spacing.lg + insets.bottom }]}>
        <View style={styles.addressRow}>
          <Ionicons name="location" size={20} color={colors.ink} />
          <View style={styles.addressBody}>
            <Text style={[type.caption, styles.muted]}>
              {target === 'pickup' ? 'PICK-UP POINT' : 'DESTINATION'}
            </Text>
            {resolving ? (
              <View style={styles.resolving}>
                <ActivityIndicator size="small" color={colors.grey} />
                <Text style={[type.body, styles.muted, { marginLeft: spacing.sm }]}>
                  Finding this place…
                </Text>
              </View>
            ) : (
              <Text style={type.bodyStrong} numberOfLines={2}>
                {label ?? 'Move the map to choose'}
              </Text>
            )}
          </View>
        </View>

        <Button label="Confirm this point" onPress={confirm} disabled={resolving || !label} />
      </FloatingCard>
    </Screen>
  );
}

const styles = StyleSheet.create({
  mapWrap: { flex: 1 },
  muted: { color: colors.textMuted },
  recentreSlot: { position: 'absolute', right: spacing.lg, bottom: spacing.lg },
  recentre: { width: 46, height: 46, minHeight: 46, borderRadius: 23, paddingHorizontal: 0 },

  card: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
  },
  addressRow: { flexDirection: 'row', marginBottom: spacing.lg },
  addressBody: { flex: 1, marginLeft: spacing.md },
  resolving: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
});
