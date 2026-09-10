/**
 * Emergency contact (spec §10).
 *
 * This screen has no skip button, and that is the entire point.
 *
 *   > Every customer and every driver must register an emergency contact name
 *   > and phone number at signup. This is **mandatory, not a settings-screen
 *   > option**, and the number is verified with a test SMS before the account
 *   > can book or drive.
 *
 * Two consequences that are easy to soften and must not be:
 *
 *   - There is no "later". A settings-screen option is a field that is empty
 *     on the night it matters.
 *   - Typing a number is not enough. It is verified by a real SMS, because an
 *     unverified number is a number that will not answer.
 *
 * The screen explains *why* before it asks. People give a real number when
 * they understand what it is for, and a fake one when it looks like a form
 * field standing between them and a taxi.
 */

import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { normalisePhone, validateEmergencyContact } from '@wantok/core';

import Button from '../../components/Button';
import { Screen, ScreenHeader } from '../../components/Chrome';
import { PhoneField, TextField } from '../../components/Forms';
import { useApp } from '../../state/AppState';
import * as api from '../../services/supabase';
import { colors, radius, spacing, type } from '../../theme';

export default function EmergencyContactScreen({ navigation }) {
  const { profile, session, setProfile } = useApp();
  const [name, setName] = useState(profile?.emergency_contact_name ?? '');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async () => {
    const verdict = validateEmergencyContact({ name, phone, ownPhone: profile?.phone });
    if (!verdict.ok) {
      setError(verdict.error);
      return;
    }

    setSending(true);
    setError(null);
    try {
      // The edge function sends the test SMS and stamps `emergency_verified_at`
      // only when it is confirmed. The app cannot set that column itself.
      await api.requestEmergencyContactVerification({
        name: name.trim(),
        phone: normalisePhone(phone),
      });
      const updated = await api.updateProfile(session.user.id, {
        emergency_contact_name: name.trim(),
        emergency_contact_phone: normalisePhone(phone),
      });
      setProfile(updated);
      setSent(true);
    } catch {
      setError('Could not send the check message. Try again when you have signal.');
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <Screen>
        <ScreenHeader title="Emergency contact" border={false} />
        <View style={styles.done}>
          <View style={styles.tick}>
            <Ionicons name="checkmark" size={34} color={colors.success} />
          </View>
          <Text style={[type.h2, styles.doneTitle]}>We have texted {name.split(' ')[0]}</Text>
          <Text style={[type.body, styles.doneBody]}>
            They will get a short message saying you have listed them as your emergency contact for
            Wantok Ride. Nothing else is sent to them unless you press SOS.
          </Text>
          <Button label="Done" onPress={() => navigation.replace('Home')} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScreenHeader title="Emergency contact" border={false} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <View style={styles.why}>
            <Ionicons name="shield-checkmark" size={20} color={colors.harbour} />
            <Text style={[type.body, styles.whyText]}>
              If you ever hold the SOS button, this is the person we text — with the vehicle
              registration, the driver’s name and a live map of where you are.
            </Text>
          </View>

          <Text style={[type.small, styles.required]}>
            Required before you can book. We check the number works by sending it one message now.
          </Text>

          <TextField
            label="Their name"
            value={name}
            onChangeText={setName}
            placeholder="Anna Warupi"
            autoCapitalize="words"
          />

          <PhoneField
            value={phone}
            onChangeText={setPhone}
            label="Their mobile"
            error={error}
            hint="Someone who answers their phone. Not your own number."
          />

          <Button label="Send the check message" onPress={submit} loading={sending} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { padding: spacing.xl },
  why: {
    flexDirection: 'row',
    backgroundColor: colors.harbourSoft,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  whyText: { flex: 1, marginLeft: spacing.md, color: colors.text },
  required: { color: colors.textMuted, marginBottom: spacing.xl },

  done: { flex: 1, padding: spacing.xl, alignItems: 'center', justifyContent: 'center' },
  tick: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.successSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xl,
  },
  doneTitle: { textAlign: 'center' },
  doneBody: {
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.md,
    marginBottom: spacing.xxl,
  },
});
