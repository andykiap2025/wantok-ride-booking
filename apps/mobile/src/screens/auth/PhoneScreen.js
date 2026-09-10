/**
 * Phone number (design kit screen 12).
 *
 * The only credential in the product. No passwords for any role (spec §16) —
 * a driver in Gerehu will not maintain one, and an email-based reset is
 * useless when a good part of the fleet has no email address.
 */

import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { isValidPngMobile, normalisePhone } from '@wantok/core';

import Button from '../../components/Button';
import { Screen, ScreenHeader } from '../../components/Chrome';
import { CodeBoxes, Keypad, PhoneField } from '../../components/Forms';
import * as api from '../../services/supabase';
import { colors, spacing, type } from '../../theme';

export default function PhoneScreen({ navigation }) {
  const [phone, setPhone] = useState('');
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);

  const valid = isValidPngMobile(phone);

  const submit = async () => {
    if (!valid) {
      setError('Enter a PNG mobile number — 8 digits starting with 7 or 8');
      return;
    }
    setSending(true);
    setError(null);
    try {
      const e164 = normalisePhone(phone);
      await api.requestOtp(e164);
      navigation.navigate('Verify', { phone: e164 });
    } catch (e) {
      setError(
        /rate|too many/i.test(e.message)
          ? 'Too many codes requested. Wait a few minutes and try again.'
          : 'Could not send the code. Check your signal and try again.',
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <Screen>
      <ScreenHeader onBack={navigation.canGoBack() ? navigation.goBack : undefined} border={false} />
      <View style={styles.body}>
        <Text style={type.h1}>What is your phone number?</Text>
        <Text style={[type.body, styles.sub]}>
          We will text you a 6-digit code. This number is how drivers reach you, so use the phone
          you carry.
        </Text>

        <PhoneField value={phone} onChangeText={setPhone} error={error} />

        <Button
          label="Send code"
          onPress={submit}
          loading={sending}
          disabled={!valid}
        />

        <Text style={[type.small, styles.legal]}>
          By continuing you agree to Wantok Ride’s terms and privacy statement. Standard SMS rates
          apply.
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, paddingHorizontal: spacing.xl, paddingTop: spacing.lg },
  sub: { color: colors.textMuted, marginTop: spacing.sm, marginBottom: spacing.xxl },
  legal: { color: colors.grey, textAlign: 'center', marginTop: spacing.lg },
});
