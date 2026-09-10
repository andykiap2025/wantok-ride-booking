/**
 * Welcome (design kit screen 2).
 *
 * One button, really. There is no password anywhere in this product, for any
 * role (spec §16), so "sign up" and "log in" are the same act — enter your
 * number, receive a code. Presenting them as two choices invites the user to
 * pick wrongly and then wonder why the app is asking for a code either way.
 *
 * So: one primary action, and a quiet line underneath for anyone who came
 * looking for the other one.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import Button from '../../components/Button';
import { PhotoHero } from '../../components/Chrome';
import Logo from '../../components/Logo';
import { IS_DRIVER_APP } from '../../services/config';
import { colors, spacing, type } from '../../theme';

export default function WelcomeScreen({ navigation }) {
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <PhotoHero source={require('../../../assets/backgrounds/welcome.jpg')}>
        <View style={[styles.top, { paddingTop: insets.top + spacing.xxl }]}>
          <Logo size={64} light tagline={IS_DRIVER_APP ? 'DRIVER' : 'PORT MORESBY'} />
        </View>

        <View style={[styles.bottom, { paddingBottom: insets.bottom + spacing.xl }]}>
          <Text style={[type.h1, styles.headline]}>
            {IS_DRIVER_APP ? 'Drive with Wantok Ride' : 'Pick your ride, know your price'}
          </Text>
          <Text style={[type.body, styles.sub]}>
            {IS_DRIVER_APP
              ? 'Accept the jobs you want. See the fare and the commission on every one before you take it.'
              : 'Every vehicle is inspected and approved. Every fare is fixed before you get in.'}
          </Text>

          <Button
            label="Continue with phone number"
            icon="phone-portrait-outline"
            onPress={() => navigation.navigate('Phone')}
            style={styles.cta}
          />
          <Text style={[type.small, styles.legal]}>
            New or returning — it is the same number and the same code.
          </Text>
        </View>
      </PhotoHero>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink },
  top: { position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'center' },
  bottom: { paddingHorizontal: spacing.xl },
  headline: { color: colors.white },
  sub: { color: 'rgba(255,255,255,0.85)', marginTop: spacing.sm, marginBottom: spacing.xl },
  cta: { marginBottom: spacing.md },
  legal: { color: 'rgba(255,255,255,0.6)', textAlign: 'center' },
});
