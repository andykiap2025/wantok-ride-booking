/**
 * Your name (design kit screen 14).
 *
 * Deliberately two fields. The source kit asked for first name, last name,
 * email and a password; this asks for the name a driver should call out and
 * nothing else. Every extra field on a signup form is a chance for someone
 * standing in the rain to give up.
 */

import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import Button from '../../components/Button';
import { Screen, ScreenHeader } from '../../components/Chrome';
import { TextField } from '../../components/Forms';
import { Avatar } from '../../components/Bits';
import { useApp } from '../../state/AppState';
import * as api from '../../services/supabase';
import { colors, spacing, type } from '../../theme';

export default function ProfileSetupScreen({ navigation }) {
  const { profile, session, setProfile } = useApp();
  const [name, setName] = useState(profile?.full_name ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const save = async () => {
    if (name.trim().length < 2) {
      setError('Enter your name');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateProfile(session.user.id, { full_name: name.trim() });
      setProfile(updated);
      navigation.navigate('EmergencyContact');
    } catch {
      setError('Could not save. Check your connection.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen>
      <ScreenHeader title="Your details" border={false} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <View style={styles.avatarRow}>
            <Avatar name={name || '?'} size={72} />
          </View>

          <Text style={[type.body, styles.sub]}>
            Your driver will see this name when you book. Use the name you go by.
          </Text>

          <TextField
            label="Full name"
            value={name}
            onChangeText={setName}
            placeholder="Dennis Warupi"
            autoCapitalize="words"
            autoComplete="name"
            error={error}
          />

          <Button label="Continue" onPress={save} loading={saving} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { padding: spacing.xl },
  avatarRow: { alignItems: 'center', marginBottom: spacing.lg },
  sub: { color: colors.textMuted, marginBottom: spacing.xl, textAlign: 'center' },
});
