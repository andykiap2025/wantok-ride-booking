/**
 * Book for later (design kit screen 26, spec §7 future flow).
 *
 * Minimum an hour ahead, maximum fourteen days. The floor is not arbitrary:
 * anything sooner is an immediate booking, and offering "in 20 minutes" as a
 * *scheduled* ride would put it through the reminder-and-release cycle, which
 * is machinery designed for tomorrow morning, not for the next half hour.
 *
 * The screen says out loud what will happen afterwards — the driver is asked
 * to re-confirm the evening before and again an hour ahead, and if he goes
 * quiet the booking comes back to the customer with 45 minutes still on the
 * clock. A passenger booking a 6am airport run needs to know that before they
 * commit to it, not discover it at 5:15.
 */

import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import {
  Timing,
  earliestSlot,
  formatPickup,
  latestSlot,
  pngLocalParts,
  validateScheduledTime,
} from '@wantok/core';

import { Screen, ScreenHeader } from '../../components/Chrome';
import { Card, Chip, SectionTitle } from '../../components/Bits';
import Button from '../../components/Button';
import { useBookingFlow } from '../../state/BookingFlow';
import { colors, radius, spacing, type } from '../../theme';

/** Half-hourly slots across the next `days` days, from the earliest legal one. */
function buildSlots(days = 3) {
  const start = earliestSlot();
  const end = latestSlot();
  const slots = [];
  const cursor = new Date(Math.ceil(start.getTime() / (30 * 60_000)) * 30 * 60_000);

  while (cursor <= end && slots.length < days * 48) {
    slots.push(new Date(cursor));
    cursor.setMinutes(cursor.getMinutes() + 30);
  }
  return slots;
}

export default function ScheduleScreen({ navigation }) {
  const flow = useBookingFlow();
  const [selected, setSelected] = useState(flow.scheduledFor ? new Date(flow.scheduledFor) : null);

  const slots = useMemo(() => buildSlots(), []);

  /** Group by local calendar day, so the list reads Today / Tomorrow / date. */
  const days = useMemo(() => {
    const grouped = new Map();
    for (const slot of slots) {
      const parts = pngLocalParts(slot);
      const key = `${parts.year}-${parts.month}-${parts.day}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(slot);
    }
    return [...grouped.entries()];
  }, [slots]);

  const verdict = selected ? validateScheduledTime(selected) : null;

  const confirm = () => {
    flow.setSchedule(selected.toISOString());
    navigation.navigate('Vehicles');
  };

  const bookNow = () => {
    flow.setSchedule(null);
    navigation.navigate('Vehicles');
  };

  return (
    <Screen>
      <ScreenHeader title="Book for later" onBack={navigation.goBack} />

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <Card style={styles.rulesCard}>
          <View style={styles.ruleRow}>
            <Ionicons name="notifications-outline" size={17} color={colors.harbour} />
            <Text style={[type.small, styles.ruleText]}>
              Your driver re-confirms the evening before and again an hour ahead.
            </Text>
          </View>
          <View style={styles.ruleRow}>
            <Ionicons name="swap-horizontal-outline" size={17} color={colors.harbour} />
            <Text style={[type.small, styles.ruleText]}>
              If they go quiet, we release the booking {Timing.RELEASE_BEFORE_MINUTES} minutes
              before pick-up and tell you straight away, so there is still time to book another.
            </Text>
          </View>
          <View style={styles.ruleRow}>
            <Ionicons name="moon-outline" size={17} color={colors.harbour} />
            <Text style={[type.small, styles.ruleText]}>
              Trips starting between 20:00 and 05:00 are charged at the night rate, whenever you
              book them.
            </Text>
          </View>
        </Card>

        {days.map(([key, daySlots]) => (
          <View key={key}>
            <SectionTitle>{formatPickup(daySlots[0]).split(',')[0].toUpperCase()}</SectionTitle>
            <View style={styles.slotWrap}>
              {daySlots.map((slot) => {
                const parts = pngLocalParts(slot);
                const hour12 = parts.hour % 12 === 0 ? 12 : parts.hour % 12;
                const night = parts.hour >= 20 || parts.hour < 5;
                return (
                  <Chip
                    key={slot.toISOString()}
                    label={`${hour12}:${String(parts.minute).padStart(2, '0')} ${parts.hour < 12 ? 'am' : 'pm'}`}
                    icon={night ? 'moon' : undefined}
                    selected={selected?.getTime() === slot.getTime()}
                    onPress={() => setSelected(slot)}
                  />
                );
              })}
            </View>
          </View>
        ))}
      </ScrollView>

      <View style={styles.footer}>
        {selected ? (
          <Text style={[type.bodyStrong, styles.chosen]}>{formatPickup(selected)}</Text>
        ) : null}
        {verdict && !verdict.ok ? (
          <Text style={[type.small, styles.error]}>{verdict.error}</Text>
        ) : null}
        <Button
          label={selected ? 'Choose a vehicle' : 'Pick a time'}
          onPress={confirm}
          disabled={!selected || !verdict?.ok}
        />
        <Button label="Book now instead" variant="outline" onPress={bookNow} style={{ marginTop: spacing.sm }} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { padding: spacing.lg, paddingBottom: spacing.xxl },
  rulesCard: { backgroundColor: colors.harbourSoft, borderColor: colors.harbourSoft },
  ruleRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: spacing.sm },
  ruleText: { flex: 1, marginLeft: spacing.sm, color: colors.text },
  slotWrap: { flexDirection: 'row', flexWrap: 'wrap' },
  footer: {
    padding: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  chosen: { textAlign: 'center', marginBottom: spacing.sm },
  error: { color: colors.danger, textAlign: 'center', marginBottom: spacing.sm },
});
