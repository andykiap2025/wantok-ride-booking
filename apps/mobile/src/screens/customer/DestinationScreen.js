/**
 * Destination search (design kit screens 17–18).
 *
 * Google Places, biased hard to the National Capital District, with a
 * hand-kept list of NCD landmarks shown before anyone types.
 *
 * That local list is not a fallback, it is the primary path. Most trips in
 * Port Moresby are between about twenty places, few of which have a street
 * address anyone uses. "Boroko Foodworld" and "Gordons Market" are how people
 * actually name a destination, and offering them as one tap is both faster for
 * the passenger and cheaper than a Places session per trip.
 *
 * Autocomplete calls are batched into one billable session by passing the same
 * `sessiontoken` through the typing and the final details lookup. Without it,
 * typing "Vision City" bills eleven calls instead of one.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Screen, ScreenHeader } from '../../components/Chrome';
import { EmptyState, SectionTitle } from '../../components/Bits';
import { TextField } from '../../components/Forms';
import { PLACES, searchPlaces } from '../../data/places';
import { getPlaceCoordinates, searchAddresses } from '../../services/maps';
import { useBookingFlow } from '../../state/BookingFlow';
import { colors, radius, spacing, type } from '../../theme';

/** A crude session token. Google only requires that it be unique per search. */
const newToken = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export default function DestinationScreen({ navigation, route }) {
  const target = route.params?.target ?? 'destination';
  const flow = useBookingFlow();

  const [query, setQuery] = useState('');
  const [remote, setRemote] = useState([]);
  const [searching, setSearching] = useState(false);
  const token = useRef(newToken());
  const debounce = useRef(null);

  const local = useMemo(() => searchPlaces(query).slice(0, query ? 6 : PLACES.length), [query]);

  /**
   * Only reach for Google once the local list has run out of ideas.
   *
   * Three characters minimum, 350ms of quiet, and only if the curated list
   * has nothing — most searches never leave the handset.
   */
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (query.trim().length < 3 || local.length >= 3) {
      setRemote([]);
      return undefined;
    }

    debounce.current = setTimeout(async () => {
      setSearching(true);
      try {
        setRemote(await searchAddresses(query, token.current));
      } catch {
        setRemote([]);
      } finally {
        setSearching(false);
      }
    }, 350);

    return () => clearTimeout(debounce.current);
  }, [query, local.length]);

  const choose = useCallback(
    (place) => {
      const value = { lat: place.lat, lng: place.lng, label: place.name };
      if (target === 'pickup') flow.setPickup(value);
      else flow.setDestination(value);
      navigation.navigate('Vehicles');
    },
    [flow, navigation, target],
  );

  const chooseRemote = useCallback(
    async (prediction) => {
      setSearching(true);
      try {
        const place = await getPlaceCoordinates(prediction.placeId, token.current);
        token.current = newToken(); // the session ends with the details call
        choose({ ...place, name: place.label });
      } finally {
        setSearching(false);
      }
    },
    [choose],
  );

  const rows = [
    ...local.map((p) => ({ ...p, source: 'local' })),
    ...remote.map((p) => ({ ...p, source: 'google', name: p.name, detail: p.detail })),
  ];

  return (
    <Screen>
      <ScreenHeader
        title={target === 'pickup' ? 'Set pick-up' : 'Where to?'}
        onBack={navigation.goBack}
      />

      <View style={styles.searchWrap}>
        <TextField
          value={query}
          onChangeText={setQuery}
          placeholder="Suburb, landmark or business"
          icon="search"
          autoFocus
          style={{ marginBottom: 0 }}
          right={
            searching ? (
              <ActivityIndicator size="small" color={colors.grey} />
            ) : query ? (
              <Pressable onPress={() => setQuery('')} hitSlop={8}>
                <Ionicons name="close-circle" size={18} color={colors.greyLight} />
              </Pressable>
            ) : null
          }
        />
      </View>

      <FlatList
        data={rows}
        keyExtractor={(item, i) => `${item.source}-${item.id ?? item.placeId ?? i}`}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          !query ? <SectionTitle>COMMON DESTINATIONS IN PORT MORESBY</SectionTitle> : null
        }
        ListEmptyComponent={
          query.length >= 3 && !searching ? (
            <EmptyState
              icon="location-outline"
              title="Nothing found"
              message="Try a suburb or a landmark nearby, or drop a pin on the map instead."
              action="Pick on the map"
              onAction={() => navigation.navigate('PickOnMap', { target })}
            />
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => (item.source === 'google' ? chooseRemote(item) : choose(item))}
          >
            <View style={styles.rowIcon}>
              <Ionicons
                name={item.source === 'google' ? 'location-outline' : 'business-outline'}
                size={17}
                color={colors.ink}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={type.bodyStrong} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={[type.small, styles.detail]} numberOfLines={1}>
                {item.detail}
              </Text>
            </View>
          </Pressable>
        )}
        ListFooterComponent={
          <Pressable
            style={styles.mapRow}
            onPress={() => navigation.navigate('PickOnMap', { target })}
          >
            <Ionicons name="map-outline" size={18} color={colors.harbour} />
            <Text style={[type.bodyStrong, styles.mapLabel]}>Pick a point on the map</Text>
          </Pressable>
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  searchWrap: { paddingHorizontal: spacing.xl, paddingVertical: spacing.md },
  list: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  detail: { color: colors.textMuted, marginTop: 1 },
  mapRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.lg,
    marginTop: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.harbourSoft,
  },
  mapLabel: { color: colors.harbour, marginLeft: spacing.sm },
});
