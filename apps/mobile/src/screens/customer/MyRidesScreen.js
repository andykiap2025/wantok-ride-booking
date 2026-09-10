/**
 * My rides (design kit screen 39).
 *
 * Three tabs, and the upcoming one is the reason the screen exists: a
 * scheduled booking that nobody can see is a scheduled booking nobody trusts.
 * Each upcoming trip shows whether the driver has re-confirmed, because that
 * is the single fact a passenger with a 6am flight wants at 21:00 the night
 * before.
 *
 * The list reads from the local mirror first and the network second, so a
 * passenger with no signal can still check what time they booked and which
 * car is coming (spec §14).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import {
  ACTIVE_STATES,
  BookingState,
  customerStateLabel,
  formatKina,
  formatPickup,
  pendingReconfirm,
} from '@wantok/core';

import { Screen, ScreenHeader } from '../../components/Chrome';
import { Card, EmptyState, Pill, RouteLine } from '../../components/Bits';
import * as api from '../../services/supabase';
import * as offline from '../../services/offline';
import { useApp } from '../../state/AppState';
import { colors, radius, spacing, type } from '../../theme';

const TABS = [
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'completed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
];

const TONE = {
  [BookingState.COMPLETED]: 'success',
  [BookingState.DECLINED]: 'danger',
  [BookingState.EXPIRED]: 'danger',
  [BookingState.CANCELLED_BY_CUSTOMER]: 'neutral',
  [BookingState.CANCELLED_BY_DRIVER]: 'danger',
  [BookingState.NO_SHOW_CUSTOMER]: 'danger',
  [BookingState.NO_SHOW_DRIVER]: 'danger',
  [BookingState.DISPUTED]: 'warning',
};

export default function MyRidesScreen({ navigation }) {
  const { profile } = useApp();
  const [tab, setTab] = useState('upcoming');
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.getMyBookings(profile.id);
      setBookings(rows);
      await offline.cacheBookings(rows);
    } catch {
      // No signal. Show what we already have rather than an error screen —
      // the times and vehicles are what the passenger came here to check.
      setBookings(await offline.getCachedBookings());
    } finally {
      setLoading(false);
    }
  }, [profile]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = bookings.filter((b) => {
    if (tab === 'upcoming') {
      return (
        ACTIVE_STATES.includes(b.state) ||
        b.state === BookingState.REQUESTED ||
        (b.is_scheduled && b.state === BookingState.CONFIRMED)
      );
    }
    if (tab === 'completed') return b.state === BookingState.COMPLETED;
    return ![...ACTIVE_STATES, BookingState.REQUESTED, BookingState.COMPLETED].includes(b.state);
  });

  return (
    <Screen>
      <ScreenHeader title="My rides" onBack={navigation.goBack} />

      <View style={styles.tabs}>
        {TABS.map((t) => (
          <Pressable
            key={t.key}
            onPress={() => setTab(t.key)}
            style={[styles.tab, tab === t.key && styles.tabOn]}
          >
            <Text style={[type.bodyStrong, tab === t.key ? styles.tabLabelOn : styles.tabLabel]}>
              {t.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(b) => b.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.ink} />}
        ListEmptyComponent={
          <EmptyState
            icon={tab === 'upcoming' ? 'calendar-outline' : 'time-outline'}
            title={
              tab === 'upcoming'
                ? 'No trips booked'
                : tab === 'completed'
                  ? 'No completed trips yet'
                  : 'Nothing cancelled'
            }
            message={tab === 'upcoming' ? 'Book a ride and it will appear here.' : null}
            action={tab === 'upcoming' ? 'Book a ride' : null}
            onAction={() => navigation.navigate('Home')}
          />
        }
        renderItem={({ item }) => {
          const live = ACTIVE_STATES.includes(item.state) || item.state === BookingState.REQUESTED;
          const reconfirm = item.is_scheduled ? pendingReconfirm(item) : null;

          return (
            <Card
              style={styles.card}
              onPress={() =>
                live
                  ? navigation.navigate(item.state === BookingState.REQUESTED ? 'Waiting' : 'Trip', {
                      bookingId: item.id,
                    })
                  : navigation.navigate('Receipt', { bookingId: item.id })
              }
            >
              <View style={styles.cardHead}>
                <View>
                  <Text style={type.bodyStrong}>
                    {item.is_scheduled && item.scheduled_for
                      ? formatPickup(item.scheduled_for)
                      : new Date(item.created_at).toLocaleDateString('en-AU', {
                          day: 'numeric',
                          month: 'short',
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                  </Text>
                  <Text style={[type.caption, styles.muted]}>{item.reference}</Text>
                </View>
                <Pill
                  label={customerStateLabel(item.state).toUpperCase()}
                  tone={live ? 'gold' : TONE[item.state] ?? 'neutral'}
                />
              </View>

              <View style={styles.cardBody}>
                <View style={{ flex: 1 }}>
                  <RouteLine pickup={item.pickup_label} destination={item.dest_label} compact />
                </View>
                <View style={styles.fare}>
                  <Text style={type.h3}>{formatKina(item.quoted_fare + (item.service_fee ?? 0))}</Text>
                  {item.is_night_rate ? (
                    <Text style={[type.caption, styles.muted]}>NIGHT RATE</Text>
                  ) : null}
                </View>
              </View>

              {/* The one fact that matters the night before a booked trip. */}
              {item.is_scheduled && item.state === BookingState.CONFIRMED ? (
                <View style={[styles.confirmBar, reconfirm ? styles.confirmBarWaiting : styles.confirmBarOk]}>
                  <Ionicons
                    name={reconfirm ? 'time-outline' : 'checkmark-circle'}
                    size={15}
                    color={reconfirm ? colors.warning : colors.success}
                  />
                  <Text
                    style={[
                      type.small,
                      { marginLeft: 6, color: reconfirm ? colors.warning : colors.success },
                    ]}
                  >
                    {reconfirm
                      ? 'Waiting for the driver to re-confirm'
                      : 'Driver has confirmed this trip'}
                  </Text>
                </View>
              ) : null}
            </Card>
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  muted: { color: colors.textMuted },
  tabs: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  tab: { paddingVertical: spacing.md, marginRight: spacing.xl, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabOn: { borderBottomColor: colors.gold },
  tabLabel: { color: colors.textMuted },
  tabLabelOn: { color: colors.text },

  list: { padding: spacing.lg, paddingBottom: spacing.xxl },
  card: { marginBottom: spacing.md },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  cardBody: { flexDirection: 'row', alignItems: 'center' },
  fare: { alignItems: 'flex-end', marginLeft: spacing.md },

  confirmBar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    marginTop: spacing.md,
  },
  confirmBarOk: { backgroundColor: colors.successSoft },
  confirmBarWaiting: { backgroundColor: colors.warningSoft },
});
