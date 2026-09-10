/**
 * Register a vehicle (spec §6, steps 2–5).
 *
 * Registration is deliberately slow and manual. It is the platform's main
 * trust asset and this screen exists to protect it, not to get out of the way.
 *
 * The six photographs are the part most likely to be watered down later, so
 * the UI enforces **the angles, not the count**. Six photographs of the front
 * of a car is not six photographs, and a customer who books a white Camry and
 * gets a different white Camry with a cracked windscreen has been failed by
 * exactly this screen. Each angle is its own slot, taken with the camera
 * rather than picked from the gallery, so the photograph is of this vehicle
 * today.
 *
 * Nothing here approves anything. Submitting books an inspection: the vehicle
 * is brought to Skyworks, an admin fills in the checklist and takes their own
 * photographs, and only then can it go live.
 */

import React, { useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';

import {
  PHOTO_ANGLE_LABELS,
  REQUIRED_PHOTO_ANGLES,
  missingPhotoAngles,
} from '@wantok/core';

import { Screen, ScreenHeader } from '../../components/Chrome';
import { Card, Chip, SectionTitle } from '../../components/Bits';
import Button from '../../components/Button';
import { TextField } from '../../components/Forms';
import * as api from '../../services/supabase';
import { useApp } from '../../state/AppState';
import { colors, radius, spacing, type } from '../../theme';

const CLASSES = [
  { code: 'SEDAN', label: 'Small sedan', seats: 4 },
  { code: 'UTE', label: 'Twin cab utility', seats: 4 },
  { code: 'WAGON4WD', label: '4WD wagon', seats: 7 },
  { code: 'BUS10', label: '10-seater bus', seats: 10 },
];

const DOCUMENTS = [
  { key: 'rego', label: 'Registration papers', icon: 'document-text-outline' },
  { key: 'insurance', label: 'Insurance certificate', icon: 'shield-outline' },
  { key: 'licence_front', label: 'Driver licence (front)', icon: 'card-outline' },
  { key: 'licence_back', label: 'Driver licence (back)', icon: 'card-outline' },
];

export default function AddVehicleScreen({ navigation }) {
  const { owner, profile } = useApp();

  const [form, setForm] = useState({
    class_code: 'SEDAN',
    make: '',
    model: '',
    year: '',
    colour: '',
    registration_no: '',
    seats: '4',
    rego_expiry: '',
    insurance_expiry: '',
  });
  const [photos, setPhotos] = useState({});
  const [documents, setDocuments] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const missing = useMemo(
    () => missingPhotoAngles(Object.keys(photos).map((angle) => ({ angle }))),
    [photos],
  );

  const detailsComplete =
    form.make && form.model && form.year && form.colour && form.registration_no &&
    form.rego_expiry && form.insurance_expiry;
  const docsComplete = DOCUMENTS.every((d) => documents[d.key]);
  const ready = detailsComplete && docsComplete && missing.length === 0;

  /** Camera only. A gallery pick could be any car, from any year. */
  const capture = async (angle) => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setError('Camera access is needed to photograph the vehicle.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.7 });
    if (!result.canceled) setPhotos((p) => ({ ...p, [angle]: result.assets[0] }));
  };

  const attachDocument = async (key) => {
    const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.7 });
    if (!result.canceled) setDocuments((d) => ({ ...d, [key]: result.assets[0] }));
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const vehicle = await api.createVehicle({
        owner_id: owner.id,
        class_code: form.class_code,
        make: form.make.trim(),
        model: form.model.trim(),
        year: Number(form.year),
        colour: form.colour.trim(),
        registration_no: form.registration_no.trim().toUpperCase(),
        seats: Number(form.seats),
        rego_expiry: form.rego_expiry,
        insurance_expiry: form.insurance_expiry,
        status: 'PENDING_INSPECTION',
      });

      // Upload into the owner's own folder in the private bucket. RLS keeps
      // it there; nothing here is publicly addressable (spec §16).
      await Promise.all(
        Object.entries(photos).map(async ([angle, asset]) => {
          const path = `${profile.id}/${vehicle.id}/${angle}.jpg`;
          const blob = await (await fetch(asset.uri)).blob();
          await api.uploadDocument('vehicle-photos', path, blob, 'image/jpeg');
          await api.addVehiclePhoto({ vehicle_id: vehicle.id, angle, url: path });
        }),
      );

      await Promise.all(
        Object.entries(documents).map(async ([key, asset]) => {
          const path = `${profile.id}/${vehicle.id}/${key}.jpg`;
          const blob = await (await fetch(asset.uri)).blob();
          await api.uploadDocument('documents', path, blob, 'image/jpeg');
        }),
      );

      navigation.replace('OwnerVehicles');
    } catch (e) {
      setError(
        /duplicate|unique/i.test(e.message)
          ? 'That registration number is already on Wantok Ride.'
          : 'Could not submit. Check your connection and try again.',
      );
      setSubmitting(false);
    }
  };

  return (
    <Screen>
      <ScreenHeader title="Register a vehicle" onBack={navigation.goBack} />

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <SectionTitle>VEHICLE CLASS</SectionTitle>
        <View style={styles.chipWrap}>
          {CLASSES.map((c) => (
            <Chip
              key={c.code}
              label={c.label}
              selected={form.class_code === c.code}
              onPress={() => {
                set('class_code', c.code);
                set('seats', String(c.seats));
              }}
            />
          ))}
        </View>

        <SectionTitle>DETAILS</SectionTitle>
        <View style={styles.pair}>
          <TextField label="Make" value={form.make} onChangeText={(v) => set('make', v)} placeholder="Toyota" style={styles.half} />
          <TextField label="Model" value={form.model} onChangeText={(v) => set('model', v)} placeholder="Camry" style={styles.half} />
        </View>
        <View style={styles.pair}>
          <TextField label="Year" value={form.year} onChangeText={(v) => set('year', v)} keyboardType="number-pad" placeholder="2019" style={styles.half} />
          <TextField label="Colour" value={form.colour} onChangeText={(v) => set('colour', v)} placeholder="White" style={styles.half} />
        </View>
        <View style={styles.pair}>
          <TextField
            label="Registration"
            value={form.registration_no}
            onChangeText={(v) => set('registration_no', v.toUpperCase())}
            placeholder="BEK-472"
            autoCapitalize="characters"
            style={styles.half}
          />
          <TextField label="Seats" value={form.seats} onChangeText={(v) => set('seats', v)} keyboardType="number-pad" style={styles.half} />
        </View>

        <SectionTitle>EXPIRY DATES</SectionTitle>
        <Text style={[type.small, styles.muted, styles.expiryNote]}>
          We warn you 30, 14 and 7 days before these run out. On the expiry date the vehicle comes
          off the app automatically until a current document is approved.
        </Text>
        <View style={styles.pair}>
          <TextField
            label="Rego expires"
            value={form.rego_expiry}
            onChangeText={(v) => set('rego_expiry', v)}
            placeholder="2027-06-30"
            style={styles.half}
          />
          <TextField
            label="Insurance expires"
            value={form.insurance_expiry}
            onChangeText={(v) => set('insurance_expiry', v)}
            placeholder="2027-03-31"
            style={styles.half}
          />
        </View>

        <SectionTitle>DOCUMENTS</SectionTitle>
        {DOCUMENTS.map((d) => (
          <Card key={d.key} style={styles.docRow} onPress={() => attachDocument(d.key)}>
            <Ionicons
              name={documents[d.key] ? 'checkmark-circle' : d.icon}
              size={20}
              color={documents[d.key] ? colors.success : colors.grey}
            />
            <Text style={[type.body, { flex: 1, marginLeft: spacing.md }]}>{d.label}</Text>
            <Text style={[type.small, styles.muted]}>{documents[d.key] ? 'Attached' : 'Attach'}</Text>
          </Card>
        ))}

        <SectionTitle>SIX PHOTOGRAPHS</SectionTitle>
        <Text style={[type.small, styles.muted, styles.expiryNote]}>
          One of each angle, taken now with the camera. These are what a passenger sees when they
          choose your vehicle.
        </Text>
        <View style={styles.photoGrid}>
          {REQUIRED_PHOTO_ANGLES.map((angle) => (
            <Pressable key={angle} style={styles.photoSlot} onPress={() => capture(angle)}>
              {photos[angle] ? (
                <>
                  <Image source={{ uri: photos[angle].uri }} style={styles.photo} />
                  <View style={styles.photoTick}>
                    <Ionicons name="checkmark" size={12} color={colors.white} />
                  </View>
                </>
              ) : (
                <View style={styles.photoEmpty}>
                  <Ionicons name="camera-outline" size={22} color={colors.grey} />
                </View>
              )}
              <Text style={[type.caption, styles.photoLabel]}>{PHOTO_ANGLE_LABELS[angle]}</Text>
            </Pressable>
          ))}
        </View>

        {missing.length ? (
          <Text style={[type.small, styles.muted]}>
            {missing.length} of 6 still needed: {missing.map((a) => PHOTO_ANGLE_LABELS[a]).join(', ')}
          </Text>
        ) : null}

        {error ? <Text style={[type.small, styles.error]}>{error}</Text> : null}
      </ScrollView>

      <View style={styles.footer}>
        <Button
          label="Submit for inspection"
          onPress={submit}
          loading={submitting}
          disabled={!ready}
        />
        <Text style={[type.small, styles.muted, styles.footNote]}>
          Bring the vehicle to Skyworks for its physical inspection. It goes live once an admin has
          approved it.
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { padding: spacing.lg, paddingBottom: spacing.xxl },
  muted: { color: colors.textMuted },
  error: { color: colors.danger, marginTop: spacing.md },
  expiryNote: { marginBottom: spacing.md },

  chipWrap: { flexDirection: 'row', flexWrap: 'wrap' },
  pair: { flexDirection: 'row', gap: spacing.md },
  half: { flex: 1 },

  docRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm, padding: spacing.md },

  photoGrid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -spacing.xs },
  photoSlot: { width: '33.33%', paddingHorizontal: spacing.xs, marginBottom: spacing.md },
  photo: { width: '100%', aspectRatio: 1, borderRadius: radius.md, backgroundColor: colors.surfaceAlt },
  photoEmpty: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoTick: {
    position: 'absolute',
    top: 6,
    right: 12,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.success,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoLabel: { color: colors.textMuted, marginTop: 4, textAlign: 'center' },

  footer: {
    padding: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  footNote: { textAlign: 'center', marginTop: spacing.sm },
});
