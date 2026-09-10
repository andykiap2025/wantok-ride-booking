/**
 * The side menu (design kit screen 36).
 *
 * Different in each variant, because a driver and a passenger want different
 * things from a menu. The passenger's is short — trips, profile, support. The
 * driver's leads with money, because that is what he opens the app to check
 * when he is not driving.
 */

import React from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatKina, formatPngMobile } from '@wantok/core';

import { Avatar, Row, Stars } from '../components/Bits';
import { Mark } from '../components/Logo';
import { IS_DRIVER_APP, SUPPORT_PHONE } from '../services/config';
import { useApp } from '../state/AppState';
import { colors, spacing, type } from '../theme';

export default function DrawerContent({ navigation }) {
  const { profile, vehicle, owner, signOut } = useApp();
  const insets = useSafeAreaInsets();

  const go = (screen, params) => {
    navigation.closeDrawer();
    navigation.navigate('App', { screen, params });
  };

  const customerItems = [
    { icon: 'time-outline', label: 'My rides', screen: 'MyRides' },
    { icon: 'person-outline', label: 'Profile', screen: 'Profile' },
  ];

  const driverItems = [
    { icon: 'wallet-outline', label: 'Commission and earnings', screen: 'Earnings' },
    { icon: 'car-outline', label: 'My vehicles', screen: 'OwnerVehicles', ownerOnly: true },
    { icon: 'person-outline', label: 'Profile', screen: 'Profile' },
  ];

  const items = (IS_DRIVER_APP ? driverItems : customerItems).filter(
    (item) => !item.ownerOnly || owner,
  );

  return (
    <View style={[styles.drawer, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable style={styles.profileRow} onPress={() => go('Profile')}>
          <Avatar name={profile?.full_name} uri={profile?.photo_url} size={54} />
          <View style={styles.profileText}>
            <Text style={[type.h3, { color: colors.white }]} numberOfLines={1}>
              {profile?.full_name ?? 'Your account'}
            </Text>
            <Text style={[type.small, styles.phone]}>
              {profile?.phone ? formatPngMobile(profile.phone) : ''}
            </Text>
            {profile?.rating_count ? (
              <Stars value={profile.rating_avg} count={profile.rating_count} size={11} />
            ) : null}
          </View>
          <Ionicons name="chevron-forward" size={18} color="rgba(255,255,255,0.5)" />
        </Pressable>

        {/* The driver's headline number, where he can see it without tapping. */}
        {IS_DRIVER_APP && vehicle ? (
          <Pressable style={styles.balanceStrip} onPress={() => go('Earnings')}>
            <View>
              <Text style={[type.caption, styles.stripLabel]}>COMMISSION OWED</Text>
              <Text style={[type.h3, { color: colors.white }]}>
                {formatKina(vehicle.balance_owed ?? 0)}
              </Text>
            </View>
            <View style={styles.stripRight}>
              <Text style={[type.caption, styles.stripLabel]}>VEHICLE</Text>
              <Text style={[type.bodyStrong, { color: colors.white }]}>
                {vehicle.registration_no}
              </Text>
            </View>
          </Pressable>
        ) : null}
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {items.map((item) => (
          <Row
            key={item.screen}
            icon={item.icon}
            title={item.label}
            onPress={() => go(item.screen)}
          />
        ))}

        <Row
          icon="call-outline"
          title="Call Wantok Ride support"
          detail={formatPngMobile(SUPPORT_PHONE)}
          onPress={() => Linking.openURL(`tel:${SUPPORT_PHONE}`)}
        />

        <Row
          icon="shield-checkmark-outline"
          title="Emergency contact"
          detail={profile?.emergency_contact_name ?? 'Not set'}
          onPress={() => go('EmergencyContact')}
        />

        <Row icon="log-out-outline" title="Sign out" tone="danger" onPress={signOut} last />
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
        <Mark size={26} />
        <Text style={[type.caption, styles.footerText]}>
          WANTOK RIDE {IS_DRIVER_APP ? 'DRIVER' : ''} · SKYWORKS SYSTEMS
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  drawer: { flex: 1, backgroundColor: colors.surface },
  header: { backgroundColor: colors.ink, paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
  profileRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.lg },
  profileText: { flex: 1, marginLeft: spacing.md },
  phone: { color: 'rgba(255,255,255,0.65)', marginTop: 1 },

  balanceStrip: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: colors.inkLift,
    borderRadius: 12,
    padding: spacing.md,
  },
  stripLabel: { color: 'rgba(255,255,255,0.55)' },
  stripRight: { alignItems: 'flex-end' },

  body: { paddingHorizontal: spacing.lg },

  footer: {
    alignItems: 'center',
    paddingTop: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  footerText: { color: colors.grey, marginTop: spacing.sm },
});
