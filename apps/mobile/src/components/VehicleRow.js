/**
 * A row in the available-vehicle list (spec §7, step 2).
 *
 * The spec says exactly what goes here: class, photo, driver name, rating,
 * straight-line distance, and the quoted fare for that class. Two of those
 * are worth defending:
 *
 *   - **Straight-line distance, labelled as distance, not as an ETA.** "2.1 km
 *     away" is honest and free. A minutes figure would imply a route nobody
 *     has paid Google to compute, and it would be wrong often enough to matter.
 *     The real ETA appears one screen later, when the customer taps a vehicle
 *     and one Directions call is justified.
 *
 *   - **The fare is the fare.** No "from", no surge, no estimate range. It is
 *     the number the passenger will hand over in cash, and it does not change
 *     once they book.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { formatDistanceKm, formatKina } from '@wantok/core';
import { classColors, colors, radius, spacing, type } from '../theme';
import { Avatar, Pill, Stars } from './Bits';

const CLASS_ICONS = {
  SEDAN: 'car-sport',
  UTE: 'car',
  WAGON4WD: 'car-sport-outline',
  BUS10: 'bus',
};

export default function VehicleRow({ row, onPress, selected, disabled }) {
  const { vehicle, quote, straightLineKm, driverProfile, className } = row;
  const accent = classColors[vehicle.class_code] ?? colors.harbour;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={
        `${className}, ${vehicle.make} ${vehicle.model}, driver ${driverProfile?.full_name}, ` +
        `${formatDistanceKm(straightLineKm)} away, ${formatKina(quote.fare)}`
      }
      style={({ pressed }) => [
        styles.row,
        selected && styles.rowSelected,
        pressed && !disabled && styles.rowPressed,
        disabled && styles.rowDisabled,
      ]}
    >
      <View style={[styles.classBadge, { backgroundColor: `${accent}18` }]}>
        <Ionicons name={CLASS_ICONS[vehicle.class_code] ?? 'car'} size={22} color={accent} />
      </View>

      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text style={type.h3} numberOfLines={1}>
            {vehicle.make} {vehicle.model}
          </Text>
          {vehicle.seats > 4 ? (
            <Pill label={`${vehicle.seats} SEATS`} tone="neutral" style={styles.seats} />
          ) : null}
        </View>

        <Text style={[type.small, styles.meta]} numberOfLines={1}>
          {vehicle.colour} · {vehicle.registration_no} · {className}
        </Text>

        <View style={styles.driverRow}>
          <Avatar name={driverProfile?.full_name} uri={driverProfile?.photo_url} size={22} />
          <Text style={[type.small, styles.driverName]} numberOfLines={1}>
            {driverProfile?.full_name}
          </Text>
          <Stars value={vehicle.rating_avg} size={11} showValue count={vehicle.rating_count} />
        </View>
      </View>

      <View style={styles.right}>
        <Text style={[type.h3, styles.fare]}>{formatKina(quote.fare)}</Text>
        {quote.isNight ? <Pill label="NIGHT RATE" tone="ink" style={styles.night} /> : null}
        <View style={styles.distanceRow}>
          <Ionicons name="navigate-outline" size={11} color={colors.grey} />
          <Text style={[type.caption, styles.distance]}>{formatDistanceKm(straightLineKm)} away</Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  rowSelected: { borderColor: colors.gold, backgroundColor: colors.goldFaint },
  rowPressed: { opacity: 0.85 },
  rowDisabled: { opacity: 0.5 },

  classBadge: {
    width: 46,
    height: 46,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },

  body: { flex: 1, marginRight: spacing.sm },
  titleRow: { flexDirection: 'row', alignItems: 'center' },
  seats: { marginLeft: spacing.sm },
  meta: { color: colors.textMuted, marginTop: 1 },
  driverRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.sm },
  driverName: { marginLeft: 6, marginRight: spacing.sm, color: colors.text, flexShrink: 1 },

  right: { alignItems: 'flex-end' },
  fare: { color: colors.text },
  night: { marginTop: 3 },
  distanceRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  distance: { color: colors.grey, marginLeft: 3 },
});
