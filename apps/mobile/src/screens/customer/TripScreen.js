/**
 * The live trip (design kit screens 30–32, 34).
 *
 * One screen for four states — confirmed, driver on the way, arrived, on the
 * trip — because to a passenger it is one situation that keeps changing, not
 * four places to be.
 *
 * Three things are on screen throughout, and none of them is negotiable:
 *
 *   - **SOS**, held for three seconds (spec §10). Present from the moment the
 *     booking is confirmed, not just once the trip starts — a passenger
 *     waiting alone at a pickup point at 21:00 is exactly who needs it.
 *   - **Call before chat** (spec §11). The dialler is the primary action and
 *     chat is secondary. Data costs money here and a phone call resolves
 *     "which gate are you at" in ten seconds.
 *   - **The locked fare**, so nobody arrives at the destination and discovers
 *     a different number.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Linking, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  BookingEvent,
  BookingState,
  Timing,
  contactWindowOpen,
  formatKina,
} from '@wantok/core';

import Map, { regionFor } from '../../components/Map';
import { FloatingCard, Sheet } from '../../components/Chrome';
import { Avatar, Pill, RouteLine } from '../../components/Bits';
import Button from '../../components/Button';
import SosButton from '../../components/SosButton';
import * as api from '../../services/supabase';
import { startSosStream } from '../../services/location';
import { TRACK_BASE_URL } from '../../services/config';
import { useApp } from '../../state/AppState';
import { colors, radius, shadow, spacing, type } from '../../theme';

/** What the passenger is told, per state. */
const STATUS = {
  [BookingState.CONFIRMED]: {
    title: 'Booking confirmed',
    body: 'Your driver has accepted and will set off shortly.',
    tone: 'info',
  },
  [BookingState.DRIVER_EN_ROUTE]: {
    title: 'Driver on the way',
    body: 'Watch the map. Be ready at your pick-up point.',
    tone: 'info',
  },
  [BookingState.ARRIVED]: {
    title: 'Your driver has arrived',
    body: 'Please come out to the vehicle.',
    tone: 'gold',
  },
  [BookingState.IN_PROGRESS]: {
    title: 'On the way',
    body: 'Sit back. The fare will not change.',
    tone: 'success',
  },
};

export default function TripScreen({ navigation, route }) {
  const { bookingId } = route.params;
  const insets = useSafeAreaInsets();
  const { profile } = useApp();

  const [booking, setBooking] = useState(null);
  const [vehicle, setVehicle] = useState(null);
  const [driver, setDriver] = useState(null);
  const [contacts, setContacts] = useState(null);
  const [driverPosition, setDriverPosition] = useState(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [sosSent, setSosSent] = useState(false);

  // --- Load and subscribe ---------------------------------------------

  useEffect(() => {
    let alive = true;

    (async () => {
      const b = await api.getBooking(bookingId);
      if (!alive) return;
      setBooking(b);

      const [v, d, c] = await Promise.all([
        api.getVehicle(b.vehicle_id).catch(() => null),
        api.getDriverProfileForVehicle(b.vehicle_id).catch(() => null),
        api.getBookingContacts(bookingId).catch(() => null),
      ]);
      if (!alive) return;
      setVehicle(v);
      setDriver(d);
      setContacts(c);
    })();

    const unwatchBooking = api.watchBooking(bookingId, (next) => alive && setBooking(next));
    return () => {
      alive = false;
      unwatchBooking();
    };
  }, [bookingId]);

  // Follow the driver's car once there is a driver to follow.
  useEffect(() => {
    if (!booking?.driver_id) return undefined;
    const unwatch = api.watchDriverPosition(booking.driver_id, (status) =>
      setDriverPosition({ lat: status.lat, lng: status.lng, heading: status.heading }),
    );
    api
      .getVehiclePresence(booking.vehicle_id)
      .then((p) => p && setDriverPosition({ lat: p.lat, lng: p.lng, heading: p.heading }))
      .catch(() => {});
    return unwatch;
  }, [booking?.driver_id, booking?.vehicle_id]);

  // Completion hands over to rating.
  useEffect(() => {
    if (booking?.state === BookingState.COMPLETED) {
      navigation.replace('Complete', { bookingId });
    } else if (
      booking &&
      [BookingState.CANCELLED_BY_DRIVER, BookingState.NO_SHOW_DRIVER].includes(booking.state)
    ) {
      navigation.replace('Home');
    }
  }, [booking, bookingId, navigation]);

  // --- Actions ---------------------------------------------------------

  const callDriver = useCallback(() => {
    const number = contacts?.driver_phone;
    if (!number) {
      Alert.alert('Number not available', 'Contact details unlock when a booking is confirmed.');
      return;
    }
    Linking.openURL(`tel:${number}`);
  }, [contacts]);

  /**
   * Trip sharing (spec §10).
   *
   * A plain web link, sent by whatever the person already uses. The recipient
   * is a mother in Gerehu with a K30 handset, not a user of this app, so
   * there is no login and nothing to install. The link expires two hours
   * after the trip ends.
   */
  const shareTrip = useCallback(async () => {
    if (!booking?.share_token) return;
    const url = `${TRACK_BASE_URL}/t/${booking.share_token}`;
    await Share.share({
      message:
        `Follow my Wantok Ride trip: ${url}\n\n` +
        `${vehicle?.colour ?? ''} ${vehicle?.make ?? ''} ${vehicle?.model ?? ''}, ` +
        `rego ${vehicle?.registration_no ?? ''}. Driver ${driver?.full_name ?? ''}.`,
    });
  }, [booking, vehicle, driver]);

  const fireSos = useCallback(async () => {
    try {
      const position = driverPosition ?? { lat: booking.pickup_lat, lng: booking.pickup_lng };
      const event = await api.triggerSos({ bookingId, role: 'CUSTOMER', location: position });
      if (event?.id) await startSosStream(event.id);
      setSosSent(true);
    } catch {
      // Never leave the person who pressed this without an answer, even if
      // the network is gone. The alert says what to do next.
      Alert.alert(
        'Could not reach Wantok Ride',
        'We could not send the alert. Call 000, or call Wantok Ride support directly.',
      );
    }
  }, [bookingId, booking, driverPosition]);

  const cancel = async (reason) => {
    try {
      await api.transition(bookingId, BookingEvent.CANCEL_CUSTOMER, { payload: { reason } });
      setCancelOpen(false);
      navigation.replace('Home');
    } catch (e) {
      Alert.alert('Could not cancel', e.message);
    }
  };

  if (!booking) {
    return <View style={styles.screen} />;
  }

  const status = STATUS[booking.state] ?? STATUS[BookingState.CONFIRMED];
  const pickup = { lat: booking.pickup_lat, lng: booking.pickup_lng };
  const destination = { lat: booking.dest_lat, lng: booking.dest_lng };
  const onTrip = booking.state === BookingState.IN_PROGRESS;
  const canCall = contactWindowOpen(booking);

  // Before boarding, the useful view is the car approaching the pickup. Once
  // moving, it is the car against the destination.
  const region = regionFor(
    onTrip ? [driverPosition, destination] : [driverPosition, pickup].filter(Boolean),
  );

  return (
    <View style={styles.screen}>
      <Map
        region={region}
        route={onTrip ? undefined : undefined}
        pickup={pickup}
        destination={onTrip ? destination : undefined}
        vehicles={driverPosition ? [{ id: 'driver', ...driverPosition, active: true }] : []}
        style={StyleSheet.absoluteFill}
      />

      {/* SOS sits top-right, thumb-reachable, above everything. */}
      <View style={[styles.sosSlot, { top: insets.top + spacing.sm }]}>
        <SosButton onTrigger={fireSos} compact />
      </View>

      <View style={[styles.topLeft, { top: insets.top + spacing.sm }]}>
        <Pressable style={styles.circleButton} onPress={shareTrip} accessibilityLabel="Share trip">
          <Ionicons name="share-social-outline" size={20} color={colors.text} />
        </Pressable>
      </View>

      {sosSent ? (
        <View style={[styles.sosBanner, { top: insets.top + 96 }]}>
          <Ionicons name="shield-checkmark" size={15} color={colors.white} />
          <Text style={[type.small, styles.sosBannerText]}>
            Alert sent. Wantok Ride is calling you now.
          </Text>
        </View>
      ) : null}

      <FloatingCard style={[styles.sheet, { paddingBottom: spacing.lg + insets.bottom }]}>
        <View style={styles.statusRow}>
          <Pill label={status.title.toUpperCase()} tone={status.tone} />
          <Text style={[type.caption, styles.ref]}>{booking.reference}</Text>
        </View>

        <Text style={[type.body, styles.statusBody]}>{status.body}</Text>

        <View style={styles.driverRow}>
          <Avatar name={driver?.full_name} uri={driver?.photo_url} size={50} />
          <View style={{ flex: 1, marginLeft: spacing.md }}>
            <Text style={type.h3}>{driver?.full_name ?? 'Your driver'}</Text>
            <Text style={[type.small, styles.muted]}>
              {vehicle ? `${vehicle.colour} ${vehicle.make} · ${vehicle.registration_no}` : ''}
            </Text>
          </View>

          {/* Call first, chat second — deliberately, per spec §11. */}
          <Pressable
            onPress={callDriver}
            disabled={!canCall}
            style={[styles.callButton, !canCall && styles.disabled]}
            accessibilityLabel="Call driver"
          >
            <Ionicons name="call" size={20} color={colors.onGold} />
          </Pressable>
          <Pressable
            onPress={() => navigation.navigate('Chat', { bookingId })}
            style={styles.chatButton}
            accessibilityLabel="Message driver"
          >
            <Ionicons name="chatbubble-ellipses-outline" size={19} color={colors.ink} />
          </Pressable>
        </View>

        <View style={styles.divider} />

        <View style={styles.fareRow}>
          <View style={{ flex: 1 }}>
            <RouteLine pickup={booking.pickup_label} destination={booking.dest_label} compact />
          </View>
          <View style={styles.fareBox}>
            <Text style={[type.caption, styles.muted]}>CASH FARE</Text>
            <Text style={type.h2}>{formatKina(booking.quoted_fare + (booking.service_fee ?? 0))}</Text>
          </View>
        </View>

        {booking.state === BookingState.ARRIVED ? (
          <View style={styles.waitNote}>
            <Ionicons name="time-outline" size={15} color={colors.warning} />
            <Text style={[type.small, styles.waitNoteText]}>
              Your driver waits {Timing.CUSTOMER_NO_SHOW_GRACE_MINUTES} minutes before the trip can
              be marked a no-show.
            </Text>
          </View>
        ) : null}

        {!onTrip ? (
          <Pressable onPress={() => setCancelOpen(true)} style={styles.cancelLink}>
            <Text style={[type.small, { color: colors.danger }]}>Cancel this booking</Text>
          </Pressable>
        ) : null}
      </FloatingCard>

      <Sheet
        visible={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Cancel this ride?"
        subtitle={
          booking.en_route_at
            ? 'Your driver has already set off. Cancelling now counts double on your record.'
            : 'Your driver has accepted. Cancelling now is recorded against your account.'
        }
        footer={
          <>
            <Button label="Keep the booking" onPress={() => setCancelOpen(false)} />
            <Button
              label="Cancel the ride"
              variant="danger"
              onPress={() => cancel('CHANGED_PLANS')}
              style={{ marginTop: spacing.sm }}
            />
          </>
        }
        scroll={false}
      >
        <Text style={[type.body, styles.muted]}>
          Cancellations are not charged, but they are counted. Three missed pickups in 30 days
          pauses new bookings until you speak to us.
        </Text>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surfaceAlt },
  muted: { color: colors.textMuted },

  sosSlot: { position: 'absolute', right: spacing.lg },
  topLeft: { position: 'absolute', left: spacing.lg },
  circleButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.float,
  },

  sosBanner: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.success,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  sosBannerText: { color: colors.white, marginLeft: spacing.sm, flex: 1 },

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
    paddingTop: spacing.lg,
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  ref: { color: colors.grey },
  statusBody: { color: colors.textMuted, marginTop: spacing.sm },

  driverRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.lg },
  callButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.sm,
  },
  chatButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.sm,
  },
  disabled: { opacity: 0.4 },

  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: spacing.lg,
  },

  fareRow: { flexDirection: 'row', alignItems: 'center' },
  fareBox: { alignItems: 'flex-end', marginLeft: spacing.lg },

  waitNote: {
    flexDirection: 'row',
    backgroundColor: colors.warningSoft,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.lg,
  },
  waitNoteText: { flex: 1, marginLeft: spacing.sm, color: colors.warning },

  cancelLink: { alignSelf: 'center', paddingVertical: spacing.md, marginTop: spacing.sm },
});
