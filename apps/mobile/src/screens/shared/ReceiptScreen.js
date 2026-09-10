/**
 * A past trip.
 *
 * This exists for one reason: every dispute about money starts with "why is it
 * this much", and the answer should be reachable by the passenger without
 * ringing anyone.
 *
 * The breakdown is reconstructed from the booking's **stored** quote — the
 * locked fare, the rate version it came from, whether the night rate applied —
 * not recomputed from today's prices. A trip taken in March shows March's
 * arithmetic in September, which is the whole point of versioning the rate
 * table.
 *
 * Raising a dispute is on this screen rather than buried in support, because
 * the moment someone wants to dispute a fare is the moment they are looking
 * at it.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import {
  BookingState,
  DISPUTE_CATEGORIES,
  customerStateLabel,
  formatDistanceKm,
  formatKina,
  formatPickup,
} from '@wantok/core';

import { Screen, ScreenHeader, Sheet } from '../../components/Chrome';
import { Avatar, Card, Pill, RouteLine, SectionTitle, Stars } from '../../components/Bits';
import Button from '../../components/Button';
import FareLines from '../../components/FareLines';
import { TextField } from '../../components/Forms';
import { IS_DRIVER_APP } from '../../services/config';
import * as api from '../../services/supabase';
import { useApp } from '../../state/AppState';
import { colors, radius, spacing, type } from '../../theme';

export default function ReceiptScreen({ navigation, route }) {
  const { bookingId } = route.params;
  const { profile } = useApp();

  const [booking, setBooking] = useState(null);
  const [vehicle, setVehicle] = useState(null);
  const [driver, setDriver] = useState(null);
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [category, setCategory] = useState(null);
  const [description, setDescription] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const b = await api.getBooking(bookingId);
      if (!alive) return;
      setBooking(b);
      const [v, d] = await Promise.all([
        api.getVehicle(b.vehicle_id).catch(() => null),
        api.getDriverProfileForVehicle(b.vehicle_id).catch(() => null),
      ]);
      if (!alive) return;
      setVehicle(v);
      setDriver(d);
    })();
    return () => {
      alive = false;
    };
  }, [bookingId]);

  const raise = useCallback(async () => {
    if (!category) return;
    if (!description.trim()) {
      setError('Tell us what happened.');
      return;
    }
    setSending(true);
    setError(null);
    try {
      await api.raiseDispute({ bookingId, category, description: description.trim() });
      setSent(true);
      setDisputeOpen(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  }, [bookingId, category, description]);

  if (!booking) return <Screen />;

  /**
   * The breakdown, from what was stored.
   *
   * `quoted_fare` and `commission_amount` are the locked figures. The line
   * items are reconstructed around them rather than re-derived from a rate
   * table, so nothing on this screen can drift from what was charged.
   */
  const stored = {
    rateVersionId: booking.rate_version_id,
    distanceKm: Number(booking.distance_km),
    isNight: booking.is_night_rate,
    fare: booking.quoted_fare,
    serviceFee: booking.service_fee ?? 0,
    total: booking.quoted_fare + (booking.service_fee ?? 0),
    commission: booking.commission_amount,
    commissionPct: Math.round((booking.commission_amount / booking.quoted_fare) * 1000) / 10,
    driverNet: booking.quoted_fare - booking.commission_amount,
  };

  const completed = booking.state === BookingState.COMPLETED;

  return (
    <Screen>
      <ScreenHeader
        title="Trip details"
        subtitle={booking.reference}
        onBack={navigation.goBack}
      />

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <Card style={styles.headCard}>
          <View style={styles.headRow}>
            <Pill
              label={customerStateLabel(booking.state).toUpperCase()}
              tone={completed ? 'success' : 'neutral'}
            />
            <Text style={[type.caption, styles.muted]}>
              {booking.is_scheduled && booking.scheduled_for
                ? formatPickup(booking.scheduled_for).toUpperCase()
                : new Date(booking.created_at)
                    .toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
                    .toUpperCase()}
            </Text>
          </View>

          <Text style={styles.bigFare}>{formatKina(stored.total)}</Text>
          <Text style={[type.small, styles.muted]}>
            Paid in cash · {formatDistanceKm(stored.distanceKm)}
            {stored.isNight ? ' · night rate' : ''}
          </Text>
        </Card>

        <Card style={{ marginBottom: spacing.sm }}>
          <RouteLine pickup={booking.pickup_label} destination={booking.dest_label} />
          {booking.completed_at ? (
            <View style={styles.timeRow}>
              <Ionicons name="time-outline" size={14} color={colors.grey} />
              <Text style={[type.small, styles.muted, { marginLeft: 6 }]}>
                {booking.started_at
                  ? `${Math.round(
                      (new Date(booking.completed_at) - new Date(booking.started_at)) / 60_000,
                    )} minute trip`
                  : ''}
              </Text>
            </View>
          ) : null}
        </Card>

        {vehicle ? (
          <Card style={{ marginBottom: spacing.sm }}>
            <View style={styles.driverRow}>
              <Avatar name={driver?.full_name} uri={driver?.photo_url} size={44} />
              <View style={{ flex: 1, marginLeft: spacing.md }}>
                <Text style={type.bodyStrong}>{driver?.full_name ?? 'Driver'}</Text>
                <Text style={[type.small, styles.muted]}>
                  {vehicle.colour} {vehicle.make} {vehicle.model} · {vehicle.registration_no}
                </Text>
              </View>
              <Stars value={vehicle.rating_avg} size={12} showValue={false} />
            </View>
          </Card>
        ) : null}

        <SectionTitle>HOW THIS FARE WAS WORKED OUT</SectionTitle>
        <Card>
          <FareLines quote={stored} showCommission={IS_DRIVER_APP} compact />
          <Text style={[type.caption, styles.rateNote]}>
            Priced from rate version {String(booking.rate_version_id).slice(0, 8)} and locked when
            you booked. Later price changes do not affect this trip.
          </Text>
        </Card>

        {sent ? (
          <Card style={styles.sentCard}>
            <Ionicons name="checkmark-circle" size={20} color={colors.success} />
            <Text style={[type.body, { flex: 1, marginLeft: spacing.sm }]}>
              We have your report. Wantok Ride will be in touch — most cases within 24 hours,
              safety reports immediately.
            </Text>
          </Card>
        ) : completed ? (
          <Button
            label="Something was wrong with this trip"
            variant="outline"
            icon="flag-outline"
            onPress={() => setDisputeOpen(true)}
            style={{ marginTop: spacing.lg }}
          />
        ) : null}
      </ScrollView>

      <Sheet
        visible={disputeOpen}
        onClose={() => setDisputeOpen(false)}
        title="What went wrong?"
        subtitle="Someone at Wantok Ride reads every one of these."
        footer={
          <Button label="Send report" onPress={raise} loading={sending} disabled={!category} />
        }
      >
        {DISPUTE_CATEGORIES.filter((c) => c.code !== 'CUSTOMER_BEHAVIOUR').map((c) => (
          <Card
            key={c.code}
            onPress={() => setCategory(c.code)}
            style={[styles.categoryRow, category === c.code && styles.categoryRowOn]}
          >
            <Ionicons
              name={category === c.code ? 'radio-button-on' : 'radio-button-off'}
              size={19}
              color={category === c.code ? colors.ink : colors.greyLight}
            />
            <View style={{ flex: 1, marginLeft: spacing.md }}>
              <Text style={type.body}>{c.label}</Text>
              {c.responseHours === 0 ? (
                <Text style={[type.caption, { color: colors.danger }]}>
                  WE RESPOND IMMEDIATELY
                </Text>
              ) : null}
            </View>
          </Card>
        ))}

        <TextField
          value={description}
          onChangeText={setDescription}
          placeholder="What happened?"
          multiline
          numberOfLines={4}
          style={{ marginTop: spacing.md }}
        />

        {error ? <Text style={[type.small, { color: colors.danger }]}>{error}</Text> : null}
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  muted: { color: colors.textMuted },

  headCard: { alignItems: 'center', marginBottom: spacing.sm },
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    alignSelf: 'stretch',
    marginBottom: spacing.md,
  },
  bigFare: { fontSize: 38, lineHeight: 46, fontWeight: '800', color: colors.text },

  timeRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.md },
  driverRow: { flexDirection: 'row', alignItems: 'center' },

  rateNote: {
    color: colors.grey,
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },

  sentCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.successSoft,
    borderColor: colors.success,
    marginTop: spacing.lg,
  },

  categoryRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm, padding: spacing.md },
  categoryRowOn: { borderColor: colors.ink, backgroundColor: colors.surfaceAlt },
});
