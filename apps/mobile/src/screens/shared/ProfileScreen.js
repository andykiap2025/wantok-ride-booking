/**
 * Profile (design kit screen 37).
 *
 * The emergency contact is on this screen but it cannot be *removed*, only
 * changed — spec §10 makes it a condition of holding an account, not a
 * preference. A settings screen that lets someone clear it is a settings
 * screen that produces accounts with an empty field on the night it matters.
 *
 * The conduct section is here deliberately too. A customer whose bookings have
 * been paused should be able to see why and what to do about it. Being blocked
 * with no explanation is how you lose someone permanently over a
 * misunderstanding.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import {
  Thresholds,
  customerBookingBlock,
  formatPngMobile,
} from '@wantok/core';

import { Screen, ScreenHeader } from '../../components/Chrome';
import { Avatar, Card, Pill, Row, SectionTitle, Stars } from '../../components/Bits';
import Button from '../../components/Button';
import { TextField } from '../../components/Forms';
import * as api from '../../services/supabase';
import { useApp } from '../../state/AppState';
import { colors, radius, spacing, type } from '../../theme';

export default function ProfileScreen({ navigation }) {
  const { profile, session, setProfile, signOut } = useApp();
  const [name, setName] = useState(profile?.full_name ?? '');
  const [saving, setSaving] = useState(false);
  const [conduct, setConduct] = useState([]);

  useEffect(() => {
    if (!profile) return;
    api
      .getConductRecords('CUSTOMER', profile.id)
      .then(setConduct)
      .catch(() => setConduct([]));
  }, [profile]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const updated = await api.updateProfile(session.user.id, { full_name: name.trim() });
      setProfile(updated);
    } finally {
      setSaving(false);
    }
  }, [name, session, setProfile]);

  if (!profile) return <Screen />;

  const block = customerBookingBlock(
    conduct.map((c) => ({ type: c.type, weight: c.weight, created_at: c.created_at })),
  );

  return (
    <Screen>
      <ScreenHeader title="Profile" onBack={navigation.goBack} />

      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.head}>
          <Avatar name={profile.full_name} uri={profile.photo_url} size={80} />
          <Text style={[type.h2, { marginTop: spacing.md }]}>{profile.full_name}</Text>
          <Text style={[type.body, styles.muted]}>{formatPngMobile(profile.phone)}</Text>
          {profile.rating_count ? (
            <View style={{ marginTop: spacing.sm }}>
              <Stars value={profile.rating_avg} count={profile.rating_count} />
            </View>
          ) : (
            <Pill label="NEW ACCOUNT" tone="info" style={{ marginTop: spacing.sm }} />
          )}
        </View>

        {block.blocked ? (
          <Card style={styles.blocked}>
            <View style={styles.blockedHead}>
              <Ionicons name="warning" size={20} color={colors.danger} />
              <Text style={[type.h3, { color: colors.danger, marginLeft: spacing.sm }]}>
                Bookings paused
              </Text>
            </View>
            <Text style={[type.body, styles.muted]}>{block.message}</Text>
            <Text style={[type.small, styles.muted, { marginTop: spacing.sm }]}>
              {block.count} missed pickups in the last {block.windowDays} days.
            </Text>
          </Card>
        ) : null}

        <SectionTitle>YOUR DETAILS</SectionTitle>
        <TextField label="Full name" value={name} onChangeText={setName} autoCapitalize="words" />
        {name.trim() !== profile.full_name ? (
          <Button label="Save changes" onPress={save} loading={saving} small />
        ) : null}

        <SectionTitle>EMERGENCY CONTACT</SectionTitle>
        <Card>
          <View style={styles.emergencyRow}>
            <View style={{ flex: 1 }}>
              <Text style={type.bodyStrong}>{profile.emergency_contact_name}</Text>
              <Text style={[type.small, styles.muted]}>
                {formatPngMobile(profile.emergency_contact_phone)}
              </Text>
            </View>
            <Pill
              label={profile.emergency_verified_at ? 'VERIFIED' : 'NOT VERIFIED'}
              tone={profile.emergency_verified_at ? 'success' : 'warning'}
            />
          </View>
          <Text style={[type.small, styles.muted, { marginTop: spacing.md }]}>
            This is who we text if you hold the SOS button. It is required on every Wantok Ride
            account — you can change it, but not remove it.
          </Text>
          <Button
            label="Change contact"
            variant="outline"
            small
            onPress={() => navigation.navigate('EmergencyContact')}
            style={{ marginTop: spacing.md }}
          />
        </Card>

        <SectionTitle>ACCOUNT</SectionTitle>
        <Card style={{ paddingVertical: 0 }}>
          <Row
            icon="document-text-outline"
            title="Privacy statement"
            detail="What we hold, and for how long"
            onPress={() => {}}
          />
          <Row icon="log-out-outline" title="Sign out" tone="danger" onPress={signOut} last />
        </Card>

        <Text style={[type.caption, styles.retention]}>
          Trip locations are kept 90 days, messages 12 months, and financial records 7 years.
        </Text>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  muted: { color: colors.textMuted },
  head: { alignItems: 'center', paddingVertical: spacing.lg },

  blocked: { backgroundColor: colors.dangerSoft, borderColor: colors.danger, marginTop: spacing.md },
  blockedHead: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },

  emergencyRow: { flexDirection: 'row', alignItems: 'center' },
  retention: { color: colors.grey, textAlign: 'center', marginTop: spacing.xl },
});
