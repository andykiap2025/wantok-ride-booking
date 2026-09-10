import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { colors, radius, shadow, spacing, type } from '../theme';

/**
 * The button.
 *
 * Four variants and no more. `danger` is the one to be careful with: it is
 * the same red as SOS, and using it for anything that is not destructive
 * spends the meaning of that colour.
 */
const VARIANTS = {
  primary: { bg: colors.gold, fg: colors.onGold, border: 'transparent' },
  secondary: { bg: colors.ink, fg: colors.white, border: 'transparent' },
  outline: { bg: 'transparent', fg: colors.ink, border: colors.borderStrong },
  danger: { bg: colors.surface, fg: colors.danger, border: colors.danger },
};

export default function Button({
  label,
  onPress,
  variant = 'primary',
  icon,
  loading = false,
  disabled = false,
  full = true,
  small = false,
  style,
}) {
  const v = VARIANTS[variant] ?? VARIANTS.primary;
  const inactive = disabled || loading;

  return (
    <Pressable
      onPress={inactive ? undefined : onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: loading }}
      style={({ pressed }) => [
        styles.base,
        small && styles.small,
        full && styles.full,
        {
          backgroundColor: v.bg,
          borderColor: v.border,
          opacity: inactive ? 0.45 : pressed ? 0.86 : 1,
        },
        variant === 'primary' && !inactive && shadow.float,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={v.fg} />
      ) : (
        <View style={styles.row}>
          {icon ? <Ionicons name={icon} size={small ? 16 : 19} color={v.fg} style={styles.icon} /> : null}
          <Text style={[type.button, small && styles.smallLabel, { color: v.fg }]} numberOfLines={1}>
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 54,
    borderRadius: radius.md,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  small: { minHeight: 40, paddingHorizontal: spacing.lg, borderRadius: radius.sm },
  smallLabel: { fontSize: 14 },
  full: { alignSelf: 'stretch' },
  row: { flexDirection: 'row', alignItems: 'center' },
  icon: { marginRight: spacing.sm },
});
