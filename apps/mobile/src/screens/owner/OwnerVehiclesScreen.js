/**
 * The owner's fleet.
 *
 * Each vehicle is a row of four facts an owner actually acts on: is it on the
 * app, what does it owe, what expires soonest, and how is it rated.
 *
 * The document warnings are the reason this screen exists at all. Spec §6:
 * registration, insurance and licence carry expiry dates, the system warns at
 * 30, 14 and 7 days, and then **automatically suspends the vehicle on the
 * expiry date**. That suspension is not negotiable and no admin approves it —
 * an expired-insurance vehicle carrying a paying passenger is the platform's
 * biggest liability. So the countdown has to be somewhere the owner cannot
 * miss it, well before the morning his driver finds himself off the app.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import {
  DocState,
  ceilingState,
  documentStatus,
  formatKina,
  onboardingProgress,
  vehicleStatusMessage,
} from '@wantok/core';

import { Screen, ScreenHeader } from '../../components/Chrome';
import { Card, EmptyState, Pill, SectionTitle } from '../../components/Bits';
import Button from '../../components/Button';
import * as api from '../../services/supabase';
import { useApp } from '../../state/AppState';
import { colors, radius, spacing, type } from '../../theme';

const STATUS_TONE = {
  APPROVED: 'success',
  PENDING_INSPECTION: 'warning',
  PENDING_DOCS: 'warning',
  DRAFT: 'neutral',
  REJECTED: 'danger',
  SUSPENDED_UNPAID: 'danger',
  SUSPENDED_DOCS: 'danger',
  SUSPENDED_ADMIN: 'danger',
  RETIRED: 'neutral',
};

export default function OwnerVehiclesScreen({ navigation }) {
  const { owner } = useApp();
  const [vehicles, setVehicles] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!owner) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setVehicles(await api.getVehiclesForOwner(owner.id));
    } finally {
      setLoading(false);
    }
  }, [owner]);

  useEffect(() => {
    load();
  }, [load]);

  if (!owner) {
    return (
      <Screen>
        <ScreenHeader title="My vehicles" onBack={navigation.goBack} />
        <EmptyState
          icon="business-outline"
          title="Not registered as an owner"
          message="Owner registration is done with Skyworks in person, along with your NID and bank details. Call Wantok Ride support to start."
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScreenHeader
        title="My vehicles"
        subtitle={`${vehicles.length} registered`}
        onBack={navigation.goBack}
      />

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.ink} />}
      >
        {vehicles.map((v) => (
          <VehicleCard key={v.id} vehicle={v} navigation={navigation} />
        ))}

        {!vehicles.length && !loading ? (
          <EmptyState
            icon="car-outline"
            title="No vehicles yet"
            message="Register a vehicle, upload its papers and six photographs, then bring it to Skyworks for inspection."
          />
        ) : null}

        <Button
          label="Register a vehicle"
          icon="add"
          variant="outline"
          onPress={() => navigation.navigate('AddVehicle')}
          style={{ marginTop: spacing.lg }}
        />
      </ScrollView>
    </Screen>
  );
}

function VehicleCard({ vehicle, navigation }) {
  const [docs, setDocs] = useState([]);
  const [balance, setBalance] = useState(vehicle.balance_owed ?? 0);

  useEffect(() => {
    let alive = true;
    (async () => {
      // The driver's licence expiry lives on the driver row, so the soonest
      // expiry across all three documents needs both.
      const driver = vehicle.driver_id ? await api.getDriver(vehicle.driver_id).catch(() => null) : null;
      if (!alive) return;
      setDocs([
        { label: 'Registration', ...documentStatus(vehicle.rego_expiry) },
        { label: 'Insurance', ...documentStatus(vehicle.insurance_expiry) },
        ...(driver ? [{ label: 'Driver licence', ...documentStatus(driver.licence_expiry) }] : []),
      ]);
    })();
    return () => {
      alive = false;
    };
  }, [vehicle]);

  const soonest = docs
    .filter((d) => d.state === DocState.WARNING || d.state === DocState.EXPIRED)
    .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0))[0];

  const money = ceilingState(balance, vehicle.commission_ceiling);
  const progress = onboardingProgress({ vehicle });

  return (
    <Card style={styles.card} onPress={() => navigation.navigate('Earnings', { vehicleId: vehicle.id })}>
      <View style={styles.cardHead}>
        <View style={{ flex: 1 }}>
          <Text style={type.h3}>
            {vehicle.make} {vehicle.model}
          </Text>
          <Text style={[type.small, styles.muted]}>
            {vehicle.colour} · {vehicle.registration_no} · {vehicle.seats} seats
          </Text>
        </View>
        <Pill label={vehicle.status.replace(/_/g, ' ')} tone={STATUS_TONE[vehicle.status] ?? 'neutral'} />
      </View>

      {vehicle.status !== 'APPROVED' ? (
        <View style={styles.statusNote}>
          <Ionicons name="information-circle-outline" size={15} color={colors.textMuted} />
          <Text style={[type.small, styles.statusNoteText]}>{vehicleStatusMessage(vehicle.status)}</Text>
        </View>
      ) : null}

      {/* Onboarding progress, for anything not yet live. */}
      {['DRAFT', 'PENDING_DOCS', 'PENDING_INSPECTION'].includes(vehicle.status) ? (
        <View style={styles.progressWrap}>
          <View style={styles.progressBar}>
            <View style={[styles.progressFill, { width: `${(progress.done / progress.total) * 100}%` }]} />
          </View>
          <Text style={[type.caption, styles.muted]}>
            STEP {progress.done} OF {progress.total}
            {progress.current ? ` · NEXT: ${progress.current.label.toUpperCase()}` : ''}
          </Text>
        </View>
      ) : null}

      <View style={styles.footRow}>
        <View style={styles.foot}>
          <Text style={[type.caption, styles.muted]}>OWES</Text>
          <Text
            style={[
              type.bodyStrong,
              money.state === 'OVER' && { color: colors.danger },
              money.state === 'WARN' && { color: colors.warning },
            ]}
          >
            {formatKina(balance)}
          </Text>
        </View>

        <View style={styles.foot}>
          <Text style={[type.caption, styles.muted]}>RATING</Text>
          <Text style={type.bodyStrong}>
            {vehicle.rating_avg ? `${vehicle.rating_avg.toFixed(1)} ★` : 'New'}
          </Text>
        </View>

        <View style={styles.foot}>
          <Text style={[type.caption, styles.muted]}>TRIPS</Text>
          <Text style={type.bodyStrong}>{vehicle.trips_completed ?? 0}</Text>
        </View>
      </View>

      {/* The warning that stops a vehicle being parked up on a Monday. */}
      {soonest ? (
        <View style={[styles.expiry, soonest.state === DocState.EXPIRED && styles.expiryDead]}>
          <Ionicons
            name={soonest.state === DocState.EXPIRED ? 'close-circle' : 'warning'}
            size={16}
            color={soonest.state === DocState.EXPIRED ? colors.danger : colors.warning}
          />
          <Text
            style={[
              type.small,
              { flex: 1, marginLeft: 6, color: soonest.state === DocState.EXPIRED ? colors.danger : colors.warning },
            ]}
          >
            {soonest.state === DocState.EXPIRED
              ? `${soonest.label} expired ${Math.abs(soonest.daysLeft)} days ago — the vehicle is off the app until a current one is approved.`
              : `${soonest.label} expires in ${soonest.daysLeft} day${soonest.daysLeft === 1 ? '' : 's'}. Upload a new one before then.`}
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  body: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  muted: { color: colors.textMuted },

  card: { marginBottom: spacing.md },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start' },

  statusNote: { flexDirection: 'row', marginTop: spacing.md },
  statusNoteText: { flex: 1, marginLeft: 6, color: colors.textMuted },

  progressWrap: { marginTop: spacing.md },
  progressBar: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.border,
    overflow: 'hidden',
    marginBottom: 6,
  },
  progressFill: { height: 6, borderRadius: 3, backgroundColor: colors.gold },

  footRow: {
    flexDirection: 'row',
    marginTop: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  foot: { flex: 1 },

  expiry: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: colors.warningSoft,
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginTop: spacing.md,
  },
  expiryDead: { backgroundColor: colors.dangerSoft },
});
