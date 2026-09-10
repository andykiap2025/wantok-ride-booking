/**
 * Waiting on the driver (design kit screen 29, spec §7 steps 5–7).
 *
 * Ninety seconds, shown as a countdown rather than a spinner. A spinner says
 * "something is happening"; a countdown says "this will be resolved by then,
 * one way or the other", which is what someone standing on a road actually
 * needs to know.
 *
 * The three ways out, and the one that matters most:
 *
 *   - **Accepted** → straight to the trip screen.
 *   - **Declined or timed out** → back to the list, *with that vehicle removed
 *     and the fare unchanged*. Never a silent reassignment. The customer chose
 *     this driver, this car and this price on purpose, and quietly swapping
 *     the vehicle underneath them is exactly the behaviour this marketplace
 *     exists as an alternative to.
 *   - **Cancelled by the customer** → free and unlogged, because no driver had
 *     accepted yet (spec §7).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { BookingEvent, BookingState, formatKina } from '@wantok/core';

import { Screen } from '../../components/Chrome';
import { Avatar, Card, RouteLine } from '../../components/Bits';
import Button from '../../components/Button';
import Countdown from '../../components/Countdown';
import * as api from '../../services/supabase';
import { useBookingFlow } from '../../state/BookingFlow';
import { colors, radius, spacing, type } from '../../theme';

export default function WaitingScreen({ navigation, route }) {
  const { bookingId } = route.params;
  const flow = useBookingFlow();

  const [booking, setBooking] = useState(null);
  const [vehicle, setVehicle] = useState(null);
  const [driver, setDriver] = useState(null);
  const [cancelling, setCancelling] = useState(false);

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

    // Realtime: the driver's accept or decline lands here as a row update.
    const unwatch = api.watchBooking(bookingId, (next) => {
      if (alive) setBooking(next);
    });

    return () => {
      alive = false;
      unwatch();
    };
  }, [bookingId]);

  /** Send the customer back to the list, minus this vehicle. */
  const backToList = useCallback(
    (message) => {
      if (booking?.vehicle_id) flow.exclude(booking.vehicle_id);
      navigation.replace('Vehicles', { message });
    },
    [booking, flow, navigation],
  );

  // React to whatever the driver did.
  useEffect(() => {
    if (!booking) return;
    if (booking.state === BookingState.CONFIRMED) {
      navigation.replace('Trip', { bookingId });
    } else if (
      booking.state === BookingState.DECLINED ||
      booking.state === BookingState.EXPIRED
    ) {
      backToList(booking.state);
    }
  }, [booking, bookingId, navigation, backToList]);

  const cancel = async () => {
    setCancelling(true);
    try {
      await api.transition(bookingId, BookingEvent.CANCEL_CUSTOMER, {
        payload: { reason: 'CHANGED_PLANS' },
      });
      navigation.replace('Home');
    } catch {
      setCancelling(false);
    }
  };

  if (!booking) {
    return (
      <Screen>
        <View style={styles.centre}>
          <Text style={type.body}>Sending your request…</Text>
        </View>
      </Screen>
    );
  }

  const scheduled = booking.is_scheduled;

  return (
    <Screen>
      <View style={styles.body}>
        <Countdown
          booking={booking}
          size={132}
          label={scheduled ? 'minutes' : 'seconds'}
          // The server closes this window on its own schedule. Firing the
          // expiry from the client is a courtesy for a phone that is awake,
          // not the mechanism.
          onExpire={() => backToList(BookingState.EXPIRED)}
        />

        <Text style={[type.h1, styles.title]}>Waiting for {driver?.full_name ?? 'the driver'}</Text>
        <Text style={[type.body, styles.sub]}>
          {scheduled
            ? 'Scheduled bookings give the driver 30 minutes to confirm. We will let you know as soon as they do.'
            : 'They have 90 seconds to accept. If they cannot take it, we will bring you straight back to the list.'}
        </Text>

        <Card style={styles.card}>
          <View style={styles.vehicleRow}>
            <Avatar name={driver?.full_name} uri={driver?.photo_url} size={44} />
            <View style={{ flex: 1, marginLeft: spacing.md }}>
              <Text style={type.bodyStrong}>
                {vehicle ? `${vehicle.colour} ${vehicle.make} ${vehicle.model}` : '—'}
              </Text>
              <Text style={[type.small, styles.muted]}>{vehicle?.registration_no}</Text>
            </View>
            <View style={styles.fare}>
              <Text style={[type.caption, styles.muted]}>FARE</Text>
              <Text style={type.h3}>{formatKina(booking.quoted_fare + (booking.service_fee ?? 0))}</Text>
            </View>
          </View>

          <View style={styles.divider} />
          <RouteLine pickup={booking.pickup_label} destination={booking.dest_label} compact />
        </Card>

        <View style={styles.reassurance}>
          <Ionicons name="lock-closed" size={14} color={colors.textMuted} />
          <Text style={[type.small, styles.reassuranceText]}>
            Your fare is locked. If this driver cannot take the trip, the price stays the same for
            the next vehicle you pick.
          </Text>
        </View>
      </View>

      <View style={styles.footer}>
        <Button
          label="Cancel request"
          variant="outline"
          onPress={cancel}
          loading={cancelling}
        />
        <Text style={[type.small, styles.freeNote]}>
          Free to cancel — no driver has accepted yet.
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, alignItems: 'center', paddingHorizontal: spacing.xl, paddingTop: spacing.xxl },
  title: { textAlign: 'center', marginTop: spacing.xl },
  sub: { textAlign: 'center', color: colors.textMuted, marginTop: spacing.sm },
  muted: { color: colors.textMuted },

  card: { width: '100%', marginTop: spacing.xxl },
  vehicleRow: { flexDirection: 'row', alignItems: 'center' },
  fare: { alignItems: 'flex-end' },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: spacing.lg,
  },

  reassurance: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.lg,
  },
  reassuranceText: { flex: 1, marginLeft: spacing.sm, color: colors.textMuted },

  footer: { padding: spacing.xl },
  freeNote: { textAlign: 'center', color: colors.grey, marginTop: spacing.sm },
});
