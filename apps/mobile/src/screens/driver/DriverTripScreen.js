/**
 * The driver's trip screen.
 *
 * One big button that says what to do next — set off, arrived, start, complete
 * — because this is operated at arm's length in a moving vehicle, in sunlight,
 * with one hand.
 *
 * Every tap is recorded with the time it happened and queued if there is no
 * signal (spec §14). That matters more than it looks: the gap between
 * `arrived_at` and now is what gates the ten-minute no-show, and a tap
 * recorded when the connection came back would let a driver mark a no-show
 * from a passenger who was never given ten minutes.
 *
 * The no-show button appears only once the grace period has actually elapsed,
 * counted from the recorded arrival. It is not a matter of trust; it is that
 * a driver with a countdown in front of him waits, and a driver with a live
 * button does not.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  BookingEvent,
  BookingState,
  Timing,
  canApply,
  contactWindowOpen,
  formatKina,
} from '@wantok/core';

import Map, { regionFor } from '../../components/Map';
import { FloatingCard, Sheet } from '../../components/Chrome';
import { Avatar, Card, Pill, RouteLine } from '../../components/Bits';
import Button from '../../components/Button';
import SosButton from '../../components/SosButton';
import { DRIVER_CANCEL_REASONS } from '@wantok/core';
import { clearTripCadence, setTripCadence, startSosStream } from '../../services/location';
import * as api from '../../services/supabase';
import * as offline from '../../services/offline';
import { useApp } from '../../state/AppState';
import { colors, radius, shadow, spacing, type } from '../../theme';

/** The single next action, per state. */
const NEXT = {
  [BookingState.CONFIRMED]: { event: BookingEvent.START_EN_ROUTE, label: 'I am on my way' },
  [BookingState.DRIVER_EN_ROUTE]: { event: BookingEvent.ARRIVE, label: 'I have arrived' },
  [BookingState.ARRIVED]: { event: BookingEvent.START_TRIP, label: 'Passenger on board — start trip' },
  [BookingState.IN_PROGRESS]: { event: BookingEvent.COMPLETE, label: 'Trip complete' },
};

export default function DriverTripScreen({ navigation, route }) {
  const { bookingId } = route.params;
  const insets = useSafeAreaInsets();
  const { connection } = useApp();

  const [booking, setBooking] = useState(null);
  const [passenger, setPassenger] = useState(null);
  const [contacts, setContacts] = useState(null);
  const [busy, setBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const [sosSent, setSosSent] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const b = await api.getBooking(bookingId);
      if (!alive) return;
      setBooking(b);
      const [p, c] = await Promise.all([
        api.getProfile(b.customer_id).catch(() => null),
        api.getBookingContacts(bookingId).catch(() => null),
      ]);
      if (!alive) return;
      setPassenger(p);
      setContacts(c);
    })();

    const unwatch = api.watchBooking(bookingId, (next) => alive && setBooking(next));
    return () => {
      alive = false;
      unwatch();
    };
  }, [bookingId]);

  // Re-render once a second so the no-show button appears the moment the
  // grace period is up, without the driver having to leave and come back.
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  /**
   * Tighten the location cadence for the trip itself: 5 seconds instead of 15
   * (spec §13). The passenger is watching this car move on a map.
   */
  useEffect(() => {
    if (booking?.state === BookingState.IN_PROGRESS) {
      setTripCadence(bookingId);
    } else if (booking && [BookingState.COMPLETED, BookingState.NO_SHOW_CUSTOMER].includes(booking.state)) {
      clearTripCadence();
    }
  }, [booking?.state, bookingId]);

  useEffect(() => {
    if (booking?.state === BookingState.COMPLETED) {
      navigation.replace('DriverRate', { bookingId });
    } else if (booking?.state === BookingState.NO_SHOW_CUSTOMER) {
      navigation.replace('DriverHome');
    }
  }, [booking?.state, bookingId, navigation]);

  /** Advance the state machine, queueing offline with the real timestamp. */
  const advance = useCallback(
    async (event, payload = {}) => {
      setBusy(true);
      const tappedAt = new Date();
      try {
        await api.transition(bookingId, event, { payload, occurredAt: tappedAt });
      } catch (e) {
        if (connection === 'offline' || /network|fetch/i.test(e.message)) {
          await offline.queueAction(bookingId, event, payload, tappedAt);
          // Move the local view on. The queue reconciles when signal returns.
          setBooking((b) => ({ ...b, state: nextStateFor(b.state, event) }));
        } else {
          Alert.alert('Could not update', e.message);
        }
      } finally {
        setBusy(false);
      }
    },
    [bookingId, connection],
  );

  const callPassenger = () => {
    const number = contacts?.customer_phone;
    if (number) Linking.openURL(`tel:${number}`);
  };

  const fireSos = useCallback(async () => {
    try {
      const event = await api.triggerSos({
        bookingId,
        role: 'DRIVER',
        location: { lat: booking.pickup_lat, lng: booking.pickup_lng },
      });
      if (event?.id) await startSosStream(event.id);
      setSosSent(true);
    } catch {
      Alert.alert('Could not reach Wantok Ride', 'Call 000 or Wantok Ride support directly.');
    }
  }, [bookingId, booking]);

  if (!booking) return <View style={styles.screen} />;

  const next = NEXT[booking.state];
  const pickup = { lat: booking.pickup_lat, lng: booking.pickup_lng };
  const destination = { lat: booking.dest_lat, lng: booking.dest_lng };
  const heading = booking.state === BookingState.IN_PROGRESS ? destination : pickup;

  // Only offer the no-show once the wait is genuinely up.
  const noShowAllowed =
    booking.state === BookingState.ARRIVED &&
    canApply(booking, BookingEvent.MARK_NO_SHOW_CUSTOMER, { actor: 'driver' }).ok;
  const waitedSeconds = booking.arrived_at
    ? Math.floor((Date.now() - new Date(booking.arrived_at).getTime()) / 1000)
    : 0;
  const waitLeft = Math.max(0, Timing.CUSTOMER_NO_SHOW_GRACE_MINUTES * 60 - waitedSeconds);

  return (
    <View style={styles.screen}>
      <Map
        region={regionFor([pickup, destination])}
        pickup={pickup}
        destination={destination}
        style={StyleSheet.absoluteFill}
      />

      <View style={[styles.sosSlot, { top: insets.top + spacing.sm }]}>
        <SosButton onTrigger={fireSos} compact />
      </View>

      {sosSent ? (
        <View style={[styles.sosBanner, { top: insets.top + 96 }]}>
          <Ionicons name="shield-checkmark" size={15} color={colors.white} />
          <Text style={[type.small, styles.sosBannerText]}>Alert sent. Wantok Ride is calling you.</Text>
        </View>
      ) : null}

      <FloatingCard style={[styles.sheet, { paddingBottom: spacing.lg + insets.bottom }]}>
        <View style={styles.headRow}>
          <Pill label={booking.state.replace(/_/g, ' ')} tone="gold" />
          <Text style={[type.caption, styles.muted]}>{booking.reference}</Text>
        </View>

        <View style={styles.passengerRow}>
          <Avatar name={passenger?.full_name} uri={passenger?.photo_url} size={44} />
          <View style={{ flex: 1, marginLeft: spacing.md }}>
            <Text style={type.bodyStrong}>{passenger?.full_name ?? 'Passenger'}</Text>
            <Text style={[type.small, styles.muted]}>
              {formatKina(booking.quoted_fare)} cash · keeps{' '}
              {formatKina(booking.quoted_fare - booking.commission_amount)}
            </Text>
          </View>
          <Pressable
            onPress={callPassenger}
            disabled={!contactWindowOpen(booking)}
            style={styles.callButton}
            accessibilityLabel="Call passenger"
          >
            <Ionicons name="call" size={19} color={colors.onGold} />
          </Pressable>
          <Pressable
            onPress={() => navigation.navigate('Chat', { bookingId })}
            style={styles.chatButton}
            accessibilityLabel="Message passenger"
          >
            <Ionicons name="chatbubble-ellipses-outline" size={18} color={colors.ink} />
          </Pressable>
        </View>

        <View style={styles.divider} />
        <RouteLine pickup={booking.pickup_label} destination={booking.dest_label} compact />

        {booking.note_to_driver ? (
          <View style={styles.note}>
            <Ionicons name="chatbubble-outline" size={14} color={colors.harbour} />
            <Text style={[type.small, styles.noteText]}>“{booking.note_to_driver}”</Text>
          </View>
        ) : null}

        <Pressable
          style={styles.navigate}
          onPress={() =>
            Linking.openURL(
              `google.navigation:q=${heading.lat},${heading.lng}&mode=d`,
            ).catch(() =>
              Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${heading.lat},${heading.lng}`),
            )
          }
        >
          <Ionicons name="navigate" size={16} color={colors.harbour} />
          <Text style={[type.bodyStrong, { color: colors.harbour, marginLeft: 6 }]}>
            Navigate to {booking.state === BookingState.IN_PROGRESS ? 'destination' : 'pick-up'}
          </Text>
        </Pressable>

        {next ? (
          <Button label={next.label} onPress={() => advance(next.event)} loading={busy} />
        ) : null}

        {booking.state === BookingState.ARRIVED ? (
          noShowAllowed ? (
            <Button
              label="Passenger did not show"
              variant="danger"
              onPress={() => advance(BookingEvent.MARK_NO_SHOW_CUSTOMER)}
              style={{ marginTop: spacing.sm }}
            />
          ) : (
            <View style={styles.waitBox}>
              <Ionicons name="time-outline" size={15} color={colors.textMuted} />
              <Text style={[type.small, styles.muted, { marginLeft: 6 }]}>
                Wait {Math.floor(waitLeft / 60)}:{String(waitLeft % 60).padStart(2, '0')} before you
                can report a no-show
              </Text>
            </View>
          )
        ) : null}

        {booking.state !== BookingState.IN_PROGRESS ? (
          <Pressable onPress={() => setCancelOpen(true)} style={styles.cancelLink}>
            <Text style={[type.small, { color: colors.danger }]}>Cancel this booking</Text>
          </Pressable>
        ) : null}
      </FloatingCard>

      <Sheet
        visible={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Cancel this booking?"
        subtitle="Cancelling after accepting is recorded against your vehicle."
        footer={<Button label="Keep the booking" onPress={() => setCancelOpen(false)} />}
      >
        {DRIVER_CANCEL_REASONS.map((r) => (
          <Card
            key={r.code}
            style={styles.reasonRow}
            onPress={() => {
              setCancelOpen(false);
              advance(BookingEvent.CANCEL_DRIVER, { reason: r.code });
              navigation.replace('DriverHome');
            }}
          >
            <Text style={type.body}>{r.label}</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.greyLight} />
          </Card>
        ))}
        <Text style={[type.small, styles.muted, { marginTop: spacing.md }]}>
          Three cancellations or no-shows in seven days flags your vehicle for review.
        </Text>
      </Sheet>
    </View>
  );
}

/** Local optimistic state for a queued action. */
function nextStateFor(state, event) {
  const map = {
    [BookingEvent.START_EN_ROUTE]: BookingState.DRIVER_EN_ROUTE,
    [BookingEvent.ARRIVE]: BookingState.ARRIVED,
    [BookingEvent.START_TRIP]: BookingState.IN_PROGRESS,
    [BookingEvent.COMPLETE]: BookingState.COMPLETED,
    [BookingEvent.MARK_NO_SHOW_CUSTOMER]: BookingState.NO_SHOW_CUSTOMER,
    [BookingEvent.CANCEL_DRIVER]: BookingState.CANCELLED_BY_DRIVER,
  };
  return map[event] ?? state;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surfaceAlt },
  muted: { color: colors.textMuted },

  sosSlot: { position: 'absolute', right: spacing.lg },
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
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
  },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  passengerRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.md },
  callButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.sm,
  },
  chatButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.sm,
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: spacing.md },

  note: {
    flexDirection: 'row',
    backgroundColor: colors.harbourSoft,
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginTop: spacing.sm,
  },
  noteText: { flex: 1, marginLeft: 6, color: colors.harbour },

  navigate: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    marginVertical: spacing.sm,
  },

  waitBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.sm,
  },
  cancelLink: { alignSelf: 'center', paddingVertical: spacing.md },
  reasonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
    padding: spacing.md,
  },
});
