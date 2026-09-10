/**
 * Home (design kit screen 16).
 *
 * A map, your pickup, and one question. Everything else — favourites, past
 * trips, the drawer — is subordinate to "where are you going".
 *
 * The vehicles shown here are decoration with a purpose: they are the real
 * approved fleet, live, and if the map is empty the customer learns that
 * before they type an address rather than after. An empty map is bad news, but
 * it is honest bad news, and spec §20 is about making sure it does not happen
 * by starting on one corridor.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import Map, { regionFor } from '../../components/Map';
import { ConnectionBanner, FloatingCard } from '../../components/Chrome';
import { Pill } from '../../components/Bits';
import { POM_CENTRE } from '../../data/places';
import { getCurrentPosition } from '../../services/location';
import { reverseGeocode } from '../../services/maps';
import * as api from '../../services/supabase';
import { useApp } from '../../state/AppState';
import { useBookingFlow } from '../../state/BookingFlow';
import { colors, radius, shadow, spacing, type } from '../../theme';

export default function HomeScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { profile, connection, pendingActions, refreshRates } = useApp();
  const flow = useBookingFlow();

  const [region, setRegion] = useState({ ...POM_CENTRE, latDelta: 0.05, lngDelta: 0.05 });
  const [nearby, setNearby] = useState([]);
  const [locating, setLocating] = useState(true);

  /** Fix the customer's position and turn it into a pickup they can read. */
  const locate = useCallback(async () => {
    setLocating(true);
    const position = await getCurrentPosition();
    if (position) {
      setRegion({ lat: position.lat, lng: position.lng, latDelta: 0.02, lngDelta: 0.02 });
      try {
        const place = await reverseGeocode(position);
        flow.setPickup({ lat: position.lat, lng: position.lng, label: place.label });
      } catch {
        flow.setPickup({ lat: position.lat, lng: position.lng, label: 'My location' });
      }
    }
    setLocating(false);
  }, [flow]);

  useEffect(() => {
    locate();
    // `locate` is stable enough for a mount effect; re-running it on every
    // flow change would re-fix the position each time the customer edits an
    // address, which fights them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Show what is actually on the road.
   *
   * This is a plain read of the `listable_vehicles` view — no Directions
   * calls, no per-vehicle work. Refreshed on a slow timer because a stale pin
   * is worse than no pin (spec §13).
   */
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const rows = await api.supabase.from('listable_vehicles').select('id, lat, lng, heading');
        if (alive && rows.data) {
          setNearby(rows.data.map((r) => ({ id: r.id, lat: r.lat, lng: r.lng, heading: r.heading })));
        }
      } catch {
        // Offline. The map still draws; the customer will find out when they
        // try to book, which is the honest moment to tell them.
      }
    };
    load();
    const timer = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const firstName = profile?.full_name?.split(' ')[0] ?? 'there';

  return (
    <View style={styles.screen}>
      <Map region={region} vehicles={nearby} pickup={flow.pickup} style={StyleSheet.absoluteFill} />

      {/* Top bar floats over the map rather than pushing it down — the map is
          the screen, not a header illustration. */}
      <View style={[styles.top, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable
          onPress={() => navigation.openDrawer()}
          style={styles.circleButton}
          accessibilityLabel="Menu"
        >
          <Ionicons name="menu" size={22} color={colors.text} />
        </Pressable>

        {nearby.length > 0 ? (
          <Pill label={`${nearby.length} VEHICLES ONLINE`} tone="ink" style={styles.onlinePill} />
        ) : null}

        <Pressable onPress={locate} style={styles.circleButton} accessibilityLabel="Find my location">
          <Ionicons name={locating ? 'ellipsis-horizontal' : 'locate'} size={20} color={colors.text} />
        </Pressable>
      </View>

      <View style={styles.bannerSlot}>
        <ConnectionBanner state={connection} pending={pendingActions} onRetry={refreshRates} />
      </View>

      <FloatingCard style={[styles.sheet, { paddingBottom: spacing.lg + insets.bottom }]}>
        <Text style={type.h2}>Hello {firstName}</Text>

        <Pressable
          style={styles.pickupRow}
          onPress={() => navigation.navigate('PickOnMap', { target: 'pickup' })}
        >
          <View style={styles.dot} />
          <Text style={[type.body, styles.pickupLabel]} numberOfLines={1}>
            {flow.pickup?.label ?? (locating ? 'Finding you…' : 'Set your pick-up point')}
          </Text>
          <Ionicons name="pencil" size={15} color={colors.grey} />
        </Pressable>

        <Pressable
          style={styles.searchBar}
          onPress={() => navigation.navigate('Destination')}
          accessibilityRole="search"
        >
          <Ionicons name="search" size={19} color={colors.grey} />
          <Text style={[type.body, styles.searchText]}>Where are you going?</Text>
        </Pressable>

        <View style={styles.quickRow}>
          <Pressable style={styles.quick} onPress={() => navigation.navigate('Destination')}>
            <Ionicons name="time-outline" size={16} color={colors.ink} />
            <Text style={[type.small, styles.quickLabel]}>Book for later</Text>
          </Pressable>
          <Pressable style={styles.quick} onPress={() => navigation.navigate('MyRides')}>
            <Ionicons name="repeat-outline" size={16} color={colors.ink} />
            <Text style={[type.small, styles.quickLabel]}>Past trips</Text>
          </Pressable>
        </View>
      </FloatingCard>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surfaceAlt },
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
  },
  circleButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.float,
  },
  onlinePill: { paddingHorizontal: spacing.md, paddingVertical: 6 },

  bannerSlot: { position: 'absolute', left: 0, right: 0, bottom: 300 },

  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
  },
  pickupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.lg,
    marginBottom: spacing.md,
  },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.ink, marginRight: spacing.md },
  pickupLabel: { flex: 1, color: colors.textMuted },

  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  searchText: { marginLeft: spacing.md, color: colors.textMuted },

  quickRow: { flexDirection: 'row', marginTop: spacing.md },
  quick: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
    marginRight: spacing.sm,
  },
  quickLabel: { marginLeft: 6, color: colors.text, fontWeight: '600' },
});
