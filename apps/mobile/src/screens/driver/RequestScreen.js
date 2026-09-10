/**
 * An incoming booking (spec §7, steps 5–7).
 *
 * Ninety seconds, and everything the driver needs to decide is on one screen
 * without scrolling: where from, where to, what it pays, what it costs him,
 * and who the passenger is.
 *
 * Two things this screen does that a dispatch app would not:
 *
 *   - **It shows the commission as a separate line** (spec §5, rule 5). The
 *     driver sees K35 fare, K3.50 commission, K31.50 kept, before he accepts.
 *     No surprises at settlement.
 *   - **Declining is a first-class action with a required reason.** Declines
 *     are not penalised — penalising them just teaches drivers to accept and
 *     then go quiet, which strands the passenger. Instead they are counted,
 *     and the reasons are the report that tells the operator which suburbs are
 *     underserved and at which hours.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import {
  BookingEvent,
  BookingState,
  DECLINE_REASONS,
  customerBadge,
  formatDistanceKm,
  formatKina,
  formatPickup,
  haversineKm,
} from '@wantok/core';

import { Screen, Sheet } from '../../components/Chrome';
import { Avatar, Card, Pill, RouteLine, Stars } from '../../components/Bits';
import Button from '../../components/Button';
import Countdown from '../../components/Countdown';
import { TextField } from '../../components/Forms';
import * as api from '../../services/supabase';
import * as offline from '../../services/offline';
import { useApp } from '../../state/AppState';
import { colors, radius, spacing, type } from '../../theme';

export default function RequestScreen({ navigation, route }) {
  const { bookingId } = route.params;
  const { connection } = useApp();

  const [booking, setBooking] = useState(null);
  const [passenger, setPassenger] = useState(null);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [reason, setReason] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const b = await api.getBooking(bookingId);
      if (!alive) return;
      setBooking(b);
      const p = await api.getProfile(b.customer_id).catch(() => null);
      if (alive) setPassenger(p);
    })();

    // If the customer cancels while the driver is deciding, get off the screen.
    const unwatch = api.watchBooking(bookingId, (next) => {
      if (!alive) return;
      setBooking(next);
      if (next.state !== BookingState.REQUESTED) {
        navigation.replace(next.state === BookingState.CONFIRMED ? 'DriverTrip' : 'DriverHome', {
          bookingId,
        });
      }
    });

    return () => {
      alive = false;
      unwatch();
    };
  }, [bookingId, navigation]);

  /**
   * Accept.
   *
   * Queued locally if there is no signal, with the time of the tap. A driver
   * in a dead spot who accepts at 14:05 must not have it recorded at 14:40 —
   * the countdown would have closed and the booking would be lost.
   */
  const accept = useCallback(async () => {
    setBusy(true);
    setError(null);
    const tappedAt = new Date();
    try {
      await api.transition(bookingId, BookingEvent.ACCEPT, { occurredAt: tappedAt });
      navigation.replace('DriverTrip', { bookingId });
    } catch (e) {
      if (connection === 'offline') {
        await offline.queueAction(bookingId, BookingEvent.ACCEPT, {}, tappedAt);
        navigation.replace('DriverTrip', { bookingId });
        return;
      }
      setError(
        /run out|time/i.test(e.message)
          ? 'That booking has timed out and gone back to the passenger.'
          : e.message,
      );
      setBusy(false);
    }
  }, [bookingId, connection, navigation]);

  const decline = useCallback(async () => {
    if (!reason) return;
    if (reason === 'OTHER' && !note.trim()) {
      setError('Tell us why, so we can fix it.');
      return;
    }
    setBusy(true);
    try {
      await api.transition(bookingId, BookingEvent.DECLINE, {
        payload: { reason, note: note.trim() || null },
      });
      navigation.replace('DriverHome');
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }, [bookingId, reason, note, navigation]);

  if (!booking) return <Screen />;

  const badge = passenger ? customerBadge(passenger) : null;
  const commissionPct = ((booking.commission_amount / booking.quoted_fare) * 100).toFixed(0);
  const pickupDistance = haversineKm(
    { lat: booking.pickup_lat, lng: booking.pickup_lng },
    { lat: booking.dest_lat, lng: booking.dest_lng },
  );

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <View style={styles.head}>
          <Countdown
            booking={booking}
            size={104}
            label={booking.is_scheduled ? 'minutes' : 'seconds'}
            onExpire={() => navigation.replace('DriverHome')}
          />
          <Text style={[type.h2, styles.title]}>New booking</Text>
          {booking.is_scheduled ? (
            <Pill label={formatPickup(booking.scheduled_for).toUpperCase()} tone="gold" icon="calendar" />
          ) : (
            <Pill label="PICK UP NOW" tone="ink" icon="flash" />
          )}
        </View>

        {/* The money, before anything else. */}
        <Card style={styles.moneyCard}>
          <View style={styles.moneyRow}>
            <View>
              <Text style={[type.caption, styles.muted]}>FARE (CASH)</Text>
              <Text style={type.hero}>{formatKina(booking.quoted_fare)}</Text>
            </View>
            <View style={styles.moneyRight}>
              <Text style={[type.caption, styles.muted]}>YOU KEEP</Text>
              <Text style={[type.h2, { color: colors.success }]}>
                {formatKina(booking.quoted_fare - booking.commission_amount)}
              </Text>
            </View>
          </View>
          <View style={styles.commissionLine}>
            <Text style={[type.small, styles.muted]}>
              Wantok Ride commission ({commissionPct}%)
            </Text>
            <Text style={[type.small, styles.muted]}>−{formatKina(booking.commission_amount)}</Text>
          </View>
          {booking.is_night_rate ? (
            <Pill label="NIGHT RATE APPLIED" tone="ink" style={{ marginTop: spacing.sm }} />
          ) : null}
        </Card>

        <Card style={styles.routeCard}>
          <RouteLine pickup={booking.pickup_label} destination={booking.dest_label} />
          <View style={styles.tripMeta}>
            <Ionicons name="navigate-outline" size={14} color={colors.grey} />
            <Text style={[type.small, styles.muted, { marginLeft: 5 }]}>
              {formatDistanceKm(booking.distance_km)} trip
            </Text>
          </View>
          {booking.note_to_driver ? (
            <View style={styles.note}>
              <Ionicons name="chatbubble-outline" size={14} color={colors.harbour} />
              <Text style={[type.small, { flex: 1, marginLeft: 6, color: colors.harbour }]}>
                “{booking.note_to_driver}”
              </Text>
            </View>
          ) : null}
        </Card>

        {/* The passenger's rating, so the driver can make an informed call. */}
        <Card>
          <View style={styles.passengerRow}>
            <Avatar name={passenger?.full_name} uri={passenger?.photo_url} size={44} />
            <View style={{ flex: 1, marginLeft: spacing.md }}>
              <Text style={type.bodyStrong}>{passenger?.full_name ?? 'Passenger'}</Text>
              {badge?.isNew ? (
                <Text style={[type.small, { color: colors.harbour }]}>New passenger</Text>
              ) : (
                <Stars value={passenger?.rating_avg} count={passenger?.rating_count} size={12} />
              )}
            </View>
          </View>
        </Card>

        {error ? <Text style={[type.small, styles.error]}>{error}</Text> : null}
      </ScrollView>

      <View style={styles.footer}>
        <Button label="Accept booking" onPress={accept} loading={busy} />
        <Button
          label="I cannot take this"
          variant="outline"
          onPress={() => setDeclineOpen(true)}
          style={{ marginTop: spacing.sm }}
        />
      </View>

      <Sheet
        visible={declineOpen}
        onClose={() => setDeclineOpen(false)}
        title="Why can you not take it?"
        subtitle="This is not held against you. It tells us where we need more vehicles."
        footer={
          <Button label="Decline booking" variant="danger" onPress={decline} loading={busy} disabled={!reason} />
        }
      >
        {DECLINE_REASONS.map((r) => (
          <Card
            key={r.code}
            onPress={() => setReason(r.code)}
            style={[styles.reasonRow, reason === r.code && styles.reasonRowOn]}
          >
            <Ionicons
              name={reason === r.code ? 'radio-button-on' : 'radio-button-off'}
              size={20}
              color={reason === r.code ? colors.ink : colors.greyLight}
            />
            <Text style={[type.body, { flex: 1, marginLeft: spacing.md }]}>{r.label}</Text>
          </Card>
        ))}

        {reason === 'OTHER' ? (
          <TextField
            value={note}
            onChangeText={setNote}
            placeholder="Tell us what happened"
            multiline
            numberOfLines={2}
            style={{ marginTop: spacing.md }}
          />
        ) : null}
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { padding: spacing.lg, paddingBottom: spacing.lg },
  muted: { color: colors.textMuted },
  error: { color: colors.danger, textAlign: 'center', marginTop: spacing.md },

  head: { alignItems: 'center', marginBottom: spacing.lg },
  title: { marginTop: spacing.md, marginBottom: spacing.sm },

  moneyCard: { marginBottom: spacing.sm },
  moneyRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  moneyRight: { alignItems: 'flex-end' },
  commissionLine: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },

  routeCard: { marginBottom: spacing.sm },
  tripMeta: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.md },
  note: {
    flexDirection: 'row',
    backgroundColor: colors.harbourSoft,
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginTop: spacing.md,
  },

  passengerRow: { flexDirection: 'row', alignItems: 'center' },

  footer: {
    padding: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },

  reasonRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm, padding: spacing.md },
  reasonRowOn: { borderColor: colors.ink, backgroundColor: colors.surfaceAlt },
});
