/**
 * Vehicle and driver profile (spec §7, steps 3–4).
 *
 * This is where the customer commits, so it is where the one remaining
 * Directions call is spent: "Now, and only now, the app calls Directions to
 * get a real route ETA and confirms the exact fare."
 *
 * What has to be on this screen for the choice to be a real one:
 *
 *   - The car: make, model, colour, registration and its photographs. A
 *     passenger waiting on a roadside identifies a vehicle by colour and
 *     plate, not by a driver's name.
 *   - The driver: name, face, rating, trips.
 *   - The reviews, unedited, most recent first.
 *   - The fare, broken down, with the night rate shown if it applies.
 *
 * Confirming locks the fare. From that moment traffic, detours and a longer
 * actual route do not change it (spec §5, rule 1).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { formatDistanceKm, formatKina, formatPickup } from '@wantok/core';

import { Screen, ScreenHeader, Sheet } from '../../components/Chrome';
import { Avatar, Card, Pill, SectionTitle, Stars } from '../../components/Bits';
import Button from '../../components/Button';
import FareLines from '../../components/FareLines';
import { TextField } from '../../components/Forms';
import { getPickupEta } from '../../services/maps';
import * as api from '../../services/supabase';
import { useApp } from '../../state/AppState';
import { useBookingFlow } from '../../state/BookingFlow';
import { classColors, colors, radius, spacing, type } from '../../theme';

export default function VehicleProfileScreen({ navigation, route }) {
  const { vehicleId } = route.params;
  const { profile, rates } = useApp();
  const flow = useBookingFlow();

  const [vehicle, setVehicle] = useState(null);
  const [driver, setDriver] = useState(null);
  const [photos, setPhotos] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [eta, setEta] = useState(null);
  const [quote, setQuote] = useState(null);
  const [loading, setLoading] = useState(true);
  const [booking, setBooking] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        const [v, ps, rs] = await Promise.all([
          api.getVehicle(vehicleId),
          api.getVehiclePhotos(vehicleId),
          api.getReviewsFor('VEHICLE', vehicleId),
        ]);
        if (!alive) return;

        setVehicle(v);
        setPhotos(ps);
        setReviews(rs);

        const d = await api.getDriverProfileForVehicle(vehicleId).catch(() => null);
        if (alive) setDriver(d);

        // The fare, from the route already fetched for this attempt.
        if (flow.route) {
          setQuote(
            await api.quoteForClass({
              classCode: v.class_code,
              distanceKm: flow.route.distanceKm,
              startAt: flow.scheduledFor ? new Date(flow.scheduledFor) : new Date(),
              rates,
            }),
          );
        }

        // Spec §13, rule 3: the driver-to-pickup ETA, only now that the
        // customer has actually opened this vehicle. Padded 30% inside
        // `getPickupEta`.
        const presence = await api.getVehiclePresence(vehicleId).catch(() => null);
        if (alive && presence?.lat) {
          getPickupEta({ lat: presence.lat, lng: presence.lng }, flow.pickup)
            .then((result) => alive && setEta(result))
            .catch(() => {});
        }
      } catch {
        if (alive) setError('Could not load this vehicle.');
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [vehicleId, flow.route, flow.pickup, flow.scheduledFor, rates]);

  const confirm = useCallback(async () => {
    setBooking(true);
    setError(null);
    try {
      const created = await api.createBooking({
        customerId: profile.id,
        vehicleId: vehicle.id,
        driverId: vehicle.driver_id,
        pickup: flow.pickup,
        destination: flow.destination,
        distanceKm: flow.route.distanceKm,
        scheduledFor: flow.scheduledFor,
        classCode: vehicle.class_code,
        note: note.trim() || null,
        rates,
      });
      navigation.replace('Waiting', { bookingId: created.id });
    } catch (e) {
      setError(
        /emergency/i.test(e.message)
          ? 'Add and verify an emergency contact before booking.'
          : /no.?show|blocked/i.test(e.message)
            ? 'New bookings are paused on your account. Call Wantok Ride support.'
            : 'Could not create the booking. Check your connection and try again.',
      );
      setBooking(false);
    }
  }, [profile, vehicle, flow, note, rates, navigation]);

  if (loading) {
    return (
      <Screen>
        <ScreenHeader onBack={navigation.goBack} />
        <View style={styles.loading}>
          <ActivityIndicator color={colors.ink} />
        </View>
      </Screen>
    );
  }

  if (!vehicle) {
    return (
      <Screen>
        <ScreenHeader onBack={navigation.goBack} />
        <View style={styles.loading}>
          <Text style={type.body}>{error ?? 'Vehicle not found.'}</Text>
        </View>
      </Screen>
    );
  }

  const accent = classColors[vehicle.class_code] ?? colors.harbour;

  return (
    <Screen>
      <ScreenHeader title={`${vehicle.make} ${vehicle.model}`} onBack={navigation.goBack} />

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        {/* Photographs: the customer is identifying a car on a roadside. */}
        {photos.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.gallery}>
            {photos.map((p) => (
              <Image key={p.id} source={{ uri: p.url }} style={styles.photo} />
            ))}
          </ScrollView>
        ) : null}

        <Card style={styles.vehicleCard}>
          <View style={styles.vehicleHead}>
            <View style={[styles.plate, { borderColor: accent }]}>
              <Text style={[type.h3, { color: accent }]}>{vehicle.registration_no}</Text>
            </View>
            <View style={{ flex: 1, marginLeft: spacing.md }}>
              <Text style={type.h3}>
                {vehicle.colour} {vehicle.make} {vehicle.model}
              </Text>
              <Text style={[type.small, styles.muted]}>
                {vehicle.year} · {vehicle.seats} seats
              </Text>
            </View>
          </View>

          <View style={styles.statRow}>
            <Stat label="RATING" value={vehicle.rating_avg ? vehicle.rating_avg.toFixed(1) : 'New'} />
            <Stat label="TRIPS" value={vehicle.trips_completed ?? 0} />
            <Stat
              label="ARRIVES IN"
              value={eta ? eta.label : '—'}
              hint={eta ? null : 'checking'}
            />
          </View>
        </Card>

        <SectionTitle>YOUR DRIVER</SectionTitle>
        <Card>
          <View style={styles.driverRow}>
            <Avatar name={driver?.full_name} uri={driver?.photo_url} size={54} />
            <View style={{ flex: 1, marginLeft: spacing.md }}>
              <Text style={type.h3}>{driver?.full_name ?? 'Driver'}</Text>
              <Stars value={driver?.rating_avg} count={driver?.rating_count} size={13} />
            </View>
          </View>
          <View style={styles.assurance}>
            <Ionicons name="shield-checkmark" size={15} color={colors.success} />
            <Text style={[type.small, styles.assuranceText]}>
              Vehicle inspected and approved by Skyworks. Registration, insurance and licence all
              current.
            </Text>
          </View>
        </Card>

        {quote ? (
          <>
            <SectionTitle>YOUR FARE</SectionTitle>
            <Card>
              <FareLines quote={quote} />
            </Card>
          </>
        ) : null}

        <SectionTitle action={reviews.length > 3 ? 'See all' : null}>
          {reviews.length ? `REVIEWS (${reviews.length})` : 'REVIEWS'}
        </SectionTitle>
        <Card>
          {reviews.length ? (
            reviews.slice(0, 4).map((r, i) => (
              <View key={r.id} style={[styles.review, i === 0 && { paddingTop: 0 }]}>
                <Stars value={r.stars} size={12} showValue={false} />
                {r.comment ? (
                  <Text style={[type.body, styles.reviewText]}>{r.comment}</Text>
                ) : null}
                <Text style={[type.caption, styles.reviewDate]}>
                  {new Date(r.created_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}
                </Text>
              </View>
            ))
          ) : (
            <Text style={[type.body, styles.muted]}>
              No reviews yet. This vehicle has been approved but has not carried a rated trip.
            </Text>
          )}
        </Card>

        {error ? <Text style={[type.small, styles.error]}>{error}</Text> : null}
      </ScrollView>

      <View style={styles.footer}>
        <View style={styles.footerTop}>
          <View>
            <Text style={[type.caption, styles.muted]}>
              {flow.scheduledFor ? formatPickup(flow.scheduledFor).toUpperCase() : 'FARE, LOCKED ON BOOKING'}
            </Text>
            <Text style={type.h1}>{quote ? formatKina(quote.total) : '—'}</Text>
          </View>
          <Button
            label="Add a note"
            variant="outline"
            small
            full={false}
            icon="chatbubble-outline"
            onPress={() => setNoteOpen(true)}
          />
        </View>
        <Button
          label={flow.scheduledFor ? 'Book this vehicle' : 'Request this vehicle'}
          onPress={confirm}
          loading={booking}
          disabled={!quote}
        />
      </View>

      <Sheet
        visible={noteOpen}
        onClose={() => setNoteOpen(false)}
        title="Note to the driver"
        subtitle="Anything that helps them find you."
        footer={<Button label="Save note" onPress={() => setNoteOpen(false)} />}
      >
        <TextField
          value={note}
          onChangeText={setNote}
          placeholder="I am in front of the bus stop, wearing a yellow shirt"
          multiline
          numberOfLines={3}
          maxLength={200}
        />
      </Sheet>
    </Screen>
  );
}

function Stat({ label, value, hint }) {
  return (
    <View style={styles.stat}>
      <Text style={[type.caption, styles.muted]}>{label}</Text>
      <Text style={type.h3}>{value}</Text>
      {hint ? <Text style={[type.caption, styles.muted]}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  muted: { color: colors.textMuted },

  gallery: { marginBottom: spacing.lg },
  photo: {
    width: 220,
    height: 140,
    borderRadius: radius.md,
    marginRight: spacing.sm,
    backgroundColor: colors.surfaceAlt,
  },

  vehicleCard: { marginBottom: spacing.sm },
  vehicleHead: { flexDirection: 'row', alignItems: 'center' },
  plate: {
    borderWidth: 2,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  statRow: {
    flexDirection: 'row',
    marginTop: spacing.lg,
    paddingTop: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  stat: { flex: 1 },

  driverRow: { flexDirection: 'row', alignItems: 'center' },
  assurance: {
    flexDirection: 'row',
    marginTop: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  assuranceText: { flex: 1, marginLeft: spacing.sm, color: colors.textMuted },

  review: {
    paddingVertical: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  reviewText: { marginTop: 6 },
  reviewDate: { color: colors.grey, marginTop: 4 },

  error: { color: colors.danger, marginTop: spacing.lg, textAlign: 'center' },

  footer: {
    padding: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  footerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
});
