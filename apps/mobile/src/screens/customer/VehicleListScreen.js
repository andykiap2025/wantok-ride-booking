/**
 * The available-vehicle list (design kit screens 22–23, spec §7 step 2).
 *
 * This is the screen the whole business model rests on. Wantok Ride has no
 * dispatch algorithm: the customer looks at the actual cars that are actually
 * near them, with the actual driver's name and rating and the actual price,
 * and picks one.
 *
 * Everything on it is either free or already paid for:
 *
 *   - The ordering is haversine, computed on the handset. Zero API cost.
 *   - The prices come from one Directions call — the route being quoted —
 *     shared across every row (spec §13, rules 1 and 2).
 *   - There is no per-vehicle ETA here. That costs a call each and would be
 *     ten calls to draw one screen. It appears when the customer taps a
 *     vehicle, which is the point at which it is worth paying for.
 *
 * The list is capped at ten, and it is honest when it is empty: "no vehicles"
 * is a dead end, but "no drivers are online right now — try scheduling for
 * later" is something a person can act on.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Thresholds, formatDistanceKm, formatPickup } from '@wantok/core';

import { Screen, ScreenHeader, Sheet } from '../../components/Chrome';
import { Chip, EmptyState, Pill, RouteLine } from '../../components/Bits';
import Button from '../../components/Button';
import VehicleRow from '../../components/VehicleRow';
import * as api from '../../services/supabase';
import { useApp } from '../../state/AppState';
import { useBookingFlow } from '../../state/BookingFlow';
import { colors, radius, spacing, type } from '../../theme';

const SEAT_OPTIONS = [1, 2, 3, 4, 6, 7, 10];

export default function VehicleListScreen({ navigation }) {
  const { rates, canQuote, ratesFetchedAt, refreshRates } = useApp();
  const flow = useBookingFlow();

  const [rows, setRows] = useState(null);
  const [reason, setReason] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [seatsOpen, setSeatsOpen] = useState(false);

  const load = useCallback(async () => {
    if (!flow.pickup || !flow.destination) return;
    setLoading(true);
    setError(null);

    try {
      // One Directions call for the whole attempt, cached ten minutes.
      const route = flow.route ?? (await flow.loadRoute());
      if (!route) {
        setLoading(false);
        return;
      }

      const list = await api.listAvailableVehicles({
        pickup: flow.pickup,
        distanceKm: route.distanceKm,
        startAt: flow.scheduledFor ? new Date(flow.scheduledFor) : new Date(),
        seatsNeeded: flow.seatsNeeded,
        excludedVehicleIds: flow.excludedVehicleIds,
        rates,
      });

      setRows(list);
      setReason(list.length ? null : { code: 'NONE_ONLINE' });
    } catch (e) {
      setError('Could not load vehicles. Check your connection and pull down to try again.');
    } finally {
      setLoading(false);
    }
  }, [flow, rates]);

  useEffect(() => {
    if (canQuote) load();
    // Reload when the excluded list grows: a driver declined and the customer
    // has been sent back here with that vehicle removed (spec §7, step 7).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canQuote, flow.excludedVehicleIds.length, flow.seatsNeeded, flow.scheduledFor]);

  /**
   * Spec §14: no quote from a rate table older than 24 hours.
   *
   * Refusing is the correct behaviour and it has to be visible. A price the
   * platform will not honour is worse than no price.
   */
  if (!canQuote) {
    return (
      <Screen>
        <ScreenHeader title="Choose a vehicle" onBack={navigation.goBack} />
        <EmptyState
          icon="cloud-offline-outline"
          title="We cannot show prices right now"
          message={
            ratesFetchedAt
              ? 'Our price list on this phone is out of date, and we will not guess at a fare. Connect to the internet and try again.'
              : 'We need to fetch the current price list before we can quote you a fare.'
          }
          action="Try again"
          onAction={refreshRates}
        />
      </Screen>
    );
  }

  const declined = flow.excludedVehicleIds.length;

  return (
    <Screen>
      <ScreenHeader
        title="Choose a vehicle"
        subtitle={flow.route ? `${formatDistanceKm(flow.route.distanceKm)} trip` : null}
        onBack={navigation.goBack}
        right={
          <Pressable onPress={() => setSeatsOpen(true)} hitSlop={8}>
            <Ionicons name="people-outline" size={22} color={colors.text} />
          </Pressable>
        }
      />

      <View style={styles.tripCard}>
        <RouteLine pickup={flow.pickup?.label} destination={flow.destination?.label} compact />
        <View style={styles.tripMeta}>
          {flow.scheduledFor ? (
            <Pill label={formatPickup(flow.scheduledFor).toUpperCase()} tone="gold" icon="calendar" />
          ) : (
            <Pill label="PICK UP NOW" tone="neutral" icon="flash" />
          )}
          {flow.seatsNeeded > 1 ? (
            <Pill label={`${flow.seatsNeeded} PASSENGERS`} tone="neutral" style={{ marginLeft: 6 }} />
          ) : null}
        </View>
      </View>

      {declined > 0 ? (
        <View style={styles.notice}>
          <Ionicons name="information-circle" size={16} color={colors.harbour} />
          <Text style={[type.small, styles.noticeText]}>
            {declined === 1 ? 'That driver was not available' : `${declined} drivers were not available`}
            . Your fare has not changed — pick another vehicle.
          </Text>
        </View>
      ) : null}

      {loading && !rows ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.ink} />
          <Text style={[type.small, styles.loadingText]}>Finding vehicles near you…</Text>
        </View>
      ) : (
        <FlatList
          data={rows ?? []}
          keyExtractor={(row) => row.vehicle.id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.ink} />}
          renderItem={({ item }) => (
            <VehicleRow
              row={item}
              onPress={() => navigation.navigate('VehicleProfile', { vehicleId: item.vehicle.id })}
            />
          )}
          ListHeaderComponent={
            rows?.length ? (
              <Text style={[type.caption, styles.count]}>
                {rows.length === Thresholds.MAX_VEHICLES_LISTED
                  ? `${rows.length} NEAREST VEHICLES`
                  : `${rows.length} VEHICLE${rows.length === 1 ? '' : 'S'} AVAILABLE`}
              </Text>
            ) : null
          }
          ListEmptyComponent={
            error ? (
              <EmptyState icon="wifi-outline" title="Could not load vehicles" message={error} action="Try again" onAction={load} />
            ) : (
              <EmptyState
                icon="car-outline"
                title="No vehicles available right now"
                message={
                  flow.seatsNeeded > 4
                    ? `No vehicle with ${flow.seatsNeeded} seats is online at the moment. Try fewer passengers, or book for later.`
                    : 'No drivers are online near you. Try again shortly, or book a ride for later today.'
                }
                action="Book for later instead"
                onAction={() => navigation.navigate('Schedule')}
              />
            )
          }
        />
      )}

      <Sheet
        visible={seatsOpen}
        onClose={() => setSeatsOpen(false)}
        title="How many passengers?"
        subtitle="We will only show vehicles with enough seats."
        scroll={false}
      >
        <View style={styles.seatRow}>
          {SEAT_OPTIONS.map((n) => (
            <Chip
              key={n}
              label={String(n)}
              selected={flow.seatsNeeded === n}
              onPress={() => {
                flow.setSeats(n);
                setSeatsOpen(false);
              }}
            />
          ))}
        </View>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  tripCard: {
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  tripMeta: { flexDirection: 'row', marginTop: spacing.md },

  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: colors.harbourSoft,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  noticeText: { flex: 1, marginLeft: spacing.sm, color: colors.harbour },

  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: colors.textMuted, marginTop: spacing.md },

  list: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  count: { color: colors.grey, marginBottom: spacing.md },

  seatRow: { flexDirection: 'row', flexWrap: 'wrap', paddingBottom: spacing.lg },
});
