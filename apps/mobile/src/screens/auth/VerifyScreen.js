/**
 * Verify the code (design kit screen 13).
 *
 * Six digits, five-minute expiry, three attempts, then a fifteen-minute
 * lockout (spec §16). All four of those are enforced by Supabase Auth — this
 * screen's job is to *explain* them, because "invalid code" with no attempt
 * count is how people end up locked out without understanding why.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Timing, formatPngMobile } from '@wantok/core';

import { Screen, ScreenHeader } from '../../components/Chrome';
import { CodeBoxes, Keypad } from '../../components/Forms';
import * as api from '../../services/supabase';
import { colors, spacing, type } from '../../theme';

export default function VerifyScreen({ navigation, route }) {
  const { phone } = route.params;
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [checking, setChecking] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(Timing.OTP_EXPIRY_MINUTES * 60);
  const submitted = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, []);

  // Submit as soon as the sixth digit lands. Making someone press a button
  // after typing exactly the required number of digits is a wasted tap.
  useEffect(() => {
    if (code.length !== Timing.OTP_LENGTH || submitted.current) return;
    submitted.current = true;

    (async () => {
      setChecking(true);
      setError(null);
      try {
        await api.verifyOtp(phone, code);
        // The auth listener in AppState takes it from here: it loads the
        // profile and the navigator swaps to the signed-in stack.
      } catch (e) {
        setError(
          /expired/i.test(e.message)
            ? 'That code has expired. Ask for a new one.'
            : /many|rate/i.test(e.message)
              ? `Too many attempts. Try again in ${Timing.OTP_LOCKOUT_MINUTES} minutes.`
              : 'That code is not right. Check the message and try again.',
        );
        setCode('');
        submitted.current = false;
      } finally {
        setChecking(false);
      }
    })();
  }, [code, phone]);

  const resend = async () => {
    setError(null);
    setCode('');
    submitted.current = false;
    setSecondsLeft(Timing.OTP_EXPIRY_MINUTES * 60);
    try {
      await api.requestOtp(phone);
    } catch {
      setError('Could not send another code. Check your signal.');
    }
  };

  const mins = Math.floor(secondsLeft / 60);
  const secs = String(secondsLeft % 60).padStart(2, '0');

  return (
    <Screen>
      <ScreenHeader onBack={navigation.goBack} border={false} />
      <View style={styles.body}>
        <Text style={type.h1}>Enter the code</Text>
        <Text style={[type.body, styles.sub]}>
          Sent to <Text style={type.bodyStrong}>+675 {formatPngMobile(phone)}</Text>
        </Text>

        <CodeBoxes value={code} error={Boolean(error)} />

        {error ? (
          <Text style={[type.small, styles.error]}>{error}</Text>
        ) : (
          <Text style={[type.small, styles.expiry]}>
            {secondsLeft > 0 ? `Code expires in ${mins}:${secs}` : 'Code expired'}
          </Text>
        )}

        <Pressable onPress={resend} hitSlop={10} style={styles.resend} disabled={checking}>
          <Text style={[type.bodyStrong, styles.resendLabel]}>Send a new code</Text>
        </Pressable>
      </View>

      <Keypad
        onPress={(d) => setCode((c) => (c.length < Timing.OTP_LENGTH ? c + d : c))}
        onDelete={() => setCode((c) => c.slice(0, -1))}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, paddingHorizontal: spacing.xl, paddingTop: spacing.lg },
  sub: { color: colors.textMuted, marginTop: spacing.sm, marginBottom: spacing.xxl },
  error: { color: colors.danger, marginTop: spacing.lg, textAlign: 'center' },
  expiry: { color: colors.grey, marginTop: spacing.lg, textAlign: 'center' },
  resend: { alignSelf: 'center', marginTop: spacing.xl, padding: spacing.sm },
  resendLabel: { color: colors.harbour },
});
