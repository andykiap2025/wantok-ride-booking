/**
 * Driver home.
 *
 * The one thing a driver needs to be able to do in a moving vehicle is go
 * online and offline, so that is a switch the size of a thumb at the top of
 * the screen. Everything else is beneath it.
 *
 * The second thing on the screen is the commission balance, and it is there
 * rather than buried in an earnings tab because of spec §8: at 80% of the
 * ceiling the driver gets a warning, and over it the vehicle disappears from
 * customer search. A driver who discovers that mid-shift, from an empty
 * request queue, will conclude the app is broken. Showing the number every
 * time he opens the app is how that never happens.
 *
 * Going online is gated (spec §10, §3): no verified emergency contact, no
 * approved vehicle, no work. The gate explains itself and links to the fix.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import {
  BookingState,
  Thresholds,
  canDrive,
  ceilingState,
  formatKina,
  formatPickup,
  pendingReconfirm,
  rebuildBalance,
  vehicleStatusMessage,
} from '@wantok/core';

import { Screen, ScreenHeader, ConnectionBanner } from '../../components/Chrome';
import { Card, EmptyState, Pill, Row, SectionTitle } from '../../components/Bits';
import Button from '../../components/Button';
import { startPresence, stopPresence } from '../../services/location';
import * as api from '../../services/supabase';
import { useApp } from '../../state/AppState';
import { colors, radius, spacing, type } from '../../theme';

export default function DriverHomeScreen({ navigation }) {
  const { profile, driver, vehicle, connection, pendingActions, reloadRoles, flush } = useApp();

  const [online, setOnline] = useState(false);
  const [ledger, setLedger] = useState({ balance: 0, entries: [] });
  const [bookings, setBookings] = useState([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const gate = profile && vehicle ? canDrive({ profile, vehicle }) : { ok: false, code: 'LOADING' };

  const load = useCallback(async () => {
    if (!driver || !vehicle) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [entries, trips, presence] = await Promise.all([
        api.getLedger(vehicle.id),
        api.getDriverBookings(driver.id),
        api.getVehiclePresence(vehicle.id).catch(() => null),
      ]);
      setLedger(rebuildBalance(entries));
      setBookings(trips);
      setOnline(Boolean(presence?.last_ping_at));
    } catch {
      setError('Could not refresh. Pull down to try again.');
    } finally {
      setLoading(false);
    }
  }, [driver, vehicle]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Toggle presence.
   *
   * Location reporting starts here and *only* here. A driver who is offline is
   * not tracked at all (spec §13) — that is a privacy commitment, not a
   * battery optimisation.
   */
  const toggle = async (next) => {
    if (next && !gate.ok) return;
    setBusy(true);
    try {
      if (next) {
        const started = await startPresence(driver.id);
        if (!started) {
          setError('Wantok Ride needs background location to keep you on the map while you drive.');
          setBusy(false);
          return;
        }
        await api.setDriverOnline(driver.id, vehicle.id, true);
      } else {
        await stopPresence();
        await api.setDriverOnline(driver.id, vehicle.id, false);
      }
      setOnline(next);
      setError(null);
    } catch {
      setError('Could not change your status. Check your connection.');
    } finally {
      setBusy(false);
    }
  };

  if (!driver || !vehicle) {
    return (
      <Screen>
        <ScreenHeader title="Wantok Ride Driver" />
        <EmptyState
          icon="car-outline"
          title="No vehicle assigned"
          message="An owner needs to register a vehicle and have it inspected and approved before you can drive. Talk to your vehicle owner or Wantok Ride support."
          action="Check again"
          onAction={reloadRoles}
        />
      </Screen>
    );
  }

  const balance = ceilingState(ledger.balance, vehicle.commission_ceiling);
  const active = bookings.find((b) =>
    [BookingState.CONFIRMED, BookingState.DRIVER_EN_ROUTE, BookingState.ARRIVED, BookingState.IN_PROGRESS].includes(
      b.state,
    ),
  );
  const scheduled = bookings.filter((b) => b.is_scheduled && b.state === BookingState.CONFIRMED);

  const today = ledger.entries.filter(
    (e) =>
      e.entry_type === 'COMMISSION' &&
      new Date(e.created_at).toDateString() === new Date().toDateString(),
  );
  const todayGross = today.reduce((sum, e) => sum + (e.gross_fare ?? 0), 0);

  return (
    <Screen>
      <ScreenHeader
        title={profile?.full_name?.split(' ')[0] ?? 'Driver'}
        subtitle={`${vehicle.registration_no} · ${vehicle.make} ${vehicle.model}`}
        right={<Ionicons name="menu" size={22} color={colors.text} onPress={navigation.openDrawer} />}
      />
      <ConnectionBanner state={connection} pending={pendingActions} onRetry={flush} />

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.ink} />}
      >
        {/* --- Online switch ------------------------------------------- */}
        <Card style={[styles.onlineCard, online && styles.onlineCardOn]}>
          <View style={styles.onlineRow}>
            <View style={{ flex: 1 }}>
              <Text style={[type.h2, online && { color: colors.white }]}>
                {online ? 'You are online' : 'You are offline'}
              </Text>
              <Text style={[type.small, online ? styles.onlineSubOn : styles.muted]}>
                {online
                  ? 'Passengers can see your vehicle and send you bookings.'
                  : gate.ok
                    ? 'Go online to start receiving bookings.'
                    : gate.error}
              </Text>
            </View>
            <Switch
              value={online}
              onValueChange={toggle}
              disabled={busy || !gate.ok}
              trackColor={{ false: colors.borderStrong, true: colors.gold }}
              thumbColor={colors.white}
            />
          </View>

          {!gate.ok && gate.code === 'EMERGENCY_CONTACT' ? (
            <Button
              label="Add your emergency contact"
              variant="outline"
              small
              onPress={() => navigation.navigate('EmergencyContact')}
              style={{ marginTop: spacing.md }}
            />
          ) : null}
        </Card>

        {error ? <Text style={[type.small, styles.error]}>{error}</Text> : null}

        {/* --- Vehicle status ------------------------------------------ */}
        {vehicle.status !== 'APPROVED' ? (
          <Card style={styles.suspendCard}>
            <View style={styles.suspendHead}>
              <Ionicons name="warning" size={20} color={colors.danger} />
              <Text style={[type.h3, { color: colors.danger, marginLeft: spacing.sm }]}>
                Vehicle off the app
              </Text>
            </View>
            <Text style={[type.body, styles.muted]}>{vehicleStatusMessage(vehicle.status)}</Text>
            {vehicle.status === 'SUSPENDED_UNPAID' ? (
              <Button
                label="Pay commission"
                onPress={() => navigation.navigate('Earnings')}
                style={{ marginTop: spacing.md }}
              />
            ) : null}
          </Card>
        ) : null}

        {/* --- Active trip --------------------------------------------- */}
        {active ? (
          <>
            <SectionTitle>CURRENT TRIP</SectionTitle>
            <Card onPress={() => navigation.navigate('DriverTrip', { bookingId: active.id })}>
              <View style={styles.activeRow}>
                <Pill label={active.state.replace(/_/g, ' ')} tone="gold" />
                <Text style={type.h3}>{formatKina(active.quoted_fare)}</Text>
              </View>
              <Text style={[type.bodyStrong, { marginTop: spacing.sm }]} numberOfLines={1}>
                {active.pickup_label} → {active.dest_label}
              </Text>
              <Button
                label="Open trip"
                small
                onPress={() => navigation.navigate('DriverTrip', { bookingId: active.id })}
                style={{ marginTop: spacing.md }}
              />
            </Card>
          </>
        ) : null}

        {/* --- Re-confirmations due ------------------------------------ */}
        {scheduled.length ? (
          <>
            <SectionTitle>BOOKED TRIPS</SectionTitle>
            {scheduled.map((b) => {
              const due = pendingReconfirm(b);
              return (
                <Card key={b.id} style={styles.scheduledCard}>
                  <View style={styles.activeRow}>
                    <Text style={type.bodyStrong}>{formatPickup(b.scheduled_for)}</Text>
                    <Text style={type.bodyStrong}>{formatKina(b.quoted_fare)}</Text>
                  </View>
                  <Text style={[type.small, styles.muted]} numberOfLines={1}>
                    {b.pickup_label} → {b.dest_label}
                  </Text>

                  {due ? (
                    <View style={[styles.reconfirm, due.urgent && styles.reconfirmUrgent]}>
                      <Text style={[type.small, { color: due.urgent ? colors.danger : colors.warning, flex: 1 }]}>
                        {due.message}
                      </Text>
                      <Button
                        label="Re-confirm"
                        small
                        full={false}
                        onPress={async () => {
                          await api.reconfirmBooking(b.id);
                          load();
                        }}
                      />
                    </View>
                  ) : null}
                </Card>
              );
            })}
          </>
        ) : null}

        {/* --- Money ---------------------------------------------------- */}
        <SectionTitle action="See all" onAction={() => navigation.navigate('Earnings')}>
          TODAY
        </SectionTitle>
        <Card>
          <View style={styles.statRow}>
            <Stat label="TRIPS" value={today.length} />
            <Stat label="FARES TAKEN" value={formatKina(todayGross)} />
            <Stat
              label="COMMISSION"
              value={formatKina(today.reduce((s, e) => s + e.amount, 0))}
            />
          </View>
        </Card>

        <SectionTitle>COMMISSION OWED</SectionTitle>
        <Card
          style={[
            balance.state === 'OVER' && styles.balanceOver,
            balance.state === 'WARN' && styles.balanceWarn,
          ]}
          onPress={() => navigation.navigate('Earnings')}
        >
          <View style={styles.balanceRow}>
            <View>
              <Text style={type.hero}>{formatKina(balance.balance)}</Text>
              <Text style={[type.small, styles.muted]}>
                of {formatKina(balance.ceiling)} limit
              </Text>
            </View>
            <Pill
              label={
                balance.state === 'OVER'
                  ? 'OVER LIMIT'
                  : balance.state === 'WARN'
                    ? 'NEARLY AT LIMIT'
                    : 'OK'
              }
              tone={balance.state === 'OVER' ? 'danger' : balance.state === 'WARN' ? 'warning' : 'success'}
            />
          </View>

          <View style={styles.meter}>
            <View
              style={[
                styles.meterFill,
                {
                  width: `${Math.min(100, balance.fraction * 100)}%`,
                  backgroundColor:
                    balance.state === 'OVER'
                      ? colors.danger
                      : balance.state === 'WARN'
                        ? colors.warning
                        : colors.success,
                },
              ]}
            />
            <View style={[styles.meterMark, { left: `${Thresholds.BALANCE_WARN_FRACTION * 100}%` }]} />
          </View>

          <Text style={[type.small, styles.muted, { marginTop: spacing.sm }]}>
            {balance.state === 'OVER'
              ? 'Your vehicle is hidden from passengers until this is paid.'
              : `Your vehicle comes off the app if this passes ${formatKina(balance.ceiling)}.`}
          </Text>
        </Card>
      </ScrollView>
    </Screen>
  );
}

function Stat({ label, value }) {
  return (
    <View style={styles.stat}>
      <Text style={[type.caption, styles.muted]}>{label}</Text>
      <Text style={type.h3}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  muted: { color: colors.textMuted },
  error: { color: colors.danger, marginTop: spacing.sm },

  onlineCard: { marginBottom: spacing.sm },
  onlineCardOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  onlineRow: { flexDirection: 'row', alignItems: 'center' },
  onlineSubOn: { color: 'rgba(255,255,255,0.72)', marginTop: 2 },

  suspendCard: { backgroundColor: colors.dangerSoft, borderColor: colors.danger, marginTop: spacing.md },
  suspendHead: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },

  activeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  scheduledCard: { marginBottom: spacing.sm },
  reconfirm: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.warningSoft,
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginTop: spacing.md,
  },
  reconfirmUrgent: { backgroundColor: colors.dangerSoft },

  statRow: { flexDirection: 'row' },
  stat: { flex: 1 },

  balanceOver: { borderColor: colors.danger, backgroundColor: colors.dangerSoft },
  balanceWarn: { borderColor: colors.warning, backgroundColor: colors.warningSoft },
  balanceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  meter: {
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.border,
    marginTop: spacing.md,
    overflow: 'hidden',
  },
  meterFill: { height: 8, borderRadius: 4 },
  meterMark: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: colors.ink,
    opacity: 0.35,
  },
});
