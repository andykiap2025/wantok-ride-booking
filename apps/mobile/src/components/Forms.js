/**
 * Form controls.
 *
 * Two things here are PNG-specific rather than generic:
 *
 *   - `PhoneField` is fixed to +675 and formats as `7412 8860`, because every
 *     account in this product is a PNG mobile and a country picker would be
 *     three taps of nothing.
 *   - `Keypad` exists because the OTP and phone screens should not raise the
 *     system keyboard. A large fixed keypad is faster and far more reliable
 *     one-handed, and it does not shift the layout when it appears.
 */

import React, { forwardRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { formatPngMobile, PNG_DIAL_CODE } from '@wantok/core';
import { colors, radius, spacing, type } from '../theme';

export const TextField = forwardRef(function TextField(
  { label, value, onChangeText, error, hint, icon, right, style, ...props },
  ref,
) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={[styles.field, style]}>
      {label ? <Text style={[type.caption, styles.label]}>{label.toUpperCase()}</Text> : null}
      <View style={[styles.box, focused && styles.boxFocused, error && styles.boxError]}>
        {icon ? <Ionicons name={icon} size={18} color={colors.grey} style={styles.leadIcon} /> : null}
        <TextInput
          ref={ref}
          value={value}
          onChangeText={onChangeText}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholderTextColor={colors.greyLight}
          style={[type.body, styles.input]}
          {...props}
        />
        {right}
      </View>
      {error ? (
        <View style={styles.errorRow}>
          <Ionicons name="alert-circle" size={13} color={colors.danger} />
          <Text style={[type.small, styles.error]}>{error}</Text>
        </View>
      ) : hint ? (
        <Text style={[type.small, styles.hint]}>{hint}</Text>
      ) : null}
    </View>
  );
});

/** +675, fixed, with PNG mobile grouping. */
export function PhoneField({ value, onChangeText, label = 'Phone number', error, hint }) {
  return (
    <View style={styles.field}>
      <Text style={[type.caption, styles.label]}>{label.toUpperCase()}</Text>
      <View style={[styles.box, error && styles.boxError]}>
        <View style={styles.dial}>
          <Text style={type.bodyStrong}>{PNG_DIAL_CODE}</Text>
        </View>
        <TextInput
          value={formatPngMobile(value) || value}
          onChangeText={(t) => onChangeText(t.replace(/\D/g, '').slice(0, 8))}
          keyboardType="number-pad"
          placeholder="7412 8860"
          placeholderTextColor={colors.greyLight}
          style={[type.body, styles.input, styles.phoneInput]}
          maxLength={9}
        />
      </View>
      {error ? (
        <View style={styles.errorRow}>
          <Ionicons name="alert-circle" size={13} color={colors.danger} />
          <Text style={[type.small, styles.error]}>{error}</Text>
        </View>
      ) : hint ? (
        <Text style={[type.small, styles.hint]}>{hint}</Text>
      ) : null}
    </View>
  );
}

/** Six boxes for the OTP. Filled left to right, driven by `Keypad`. */
export function CodeBoxes({ value, length = 6, error }) {
  return (
    <View style={styles.codeRow}>
      {Array.from({ length }).map((_, i) => (
        <View
          key={i}
          style={[
            styles.codeBox,
            i === value.length && styles.codeBoxActive,
            error && styles.codeBoxError,
          ]}
        >
          <Text style={type.h2}>{value[i] ?? ''}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * A big numeric keypad.
 *
 * Keys are 64pt tall, which is well past the 44pt minimum — this is used
 * standing on a roadside, one-handed, in bright sun.
 */
export function Keypad({ onPress, onDelete }) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];
  return (
    <View style={styles.keypad}>
      {keys.map((key, i) => {
        if (key === '') return <View key={i} style={styles.key} />;
        const isDelete = key === 'del';
        return (
          <Pressable
            key={i}
            onPress={() => (isDelete ? onDelete() : onPress(key))}
            accessibilityRole="button"
            accessibilityLabel={isDelete ? 'Delete' : key}
            style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
          >
            {isDelete ? (
              <Ionicons name="backspace-outline" size={24} color={colors.text} />
            ) : (
              <Text style={styles.keyLabel}>{key}</Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { marginBottom: spacing.lg },
  label: { color: colors.grey, marginBottom: 6 },
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
  },
  boxFocused: { borderColor: colors.ink },
  boxError: { borderColor: colors.danger, backgroundColor: colors.dangerSoft },
  leadIcon: { marginRight: spacing.sm },
  input: { flex: 1, color: colors.text, paddingVertical: spacing.md },
  phoneInput: { letterSpacing: 1 },
  dial: {
    paddingRight: spacing.md,
    marginRight: spacing.md,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    paddingVertical: spacing.md,
  },
  errorRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  error: { color: colors.danger, marginLeft: 4, flex: 1 },
  hint: { color: colors.textMuted, marginTop: 6 },

  codeRow: { flexDirection: 'row', justifyContent: 'space-between' },
  codeBox: {
    width: 48,
    height: 60,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  codeBoxActive: { borderColor: colors.ink },
  codeBoxError: { borderColor: colors.danger, backgroundColor: colors.dangerSoft },

  keypad: { flexDirection: 'row', flexWrap: 'wrap' },
  key: {
    width: '33.33%',
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyPressed: { backgroundColor: colors.surfaceAlt, borderRadius: radius.md },
  keyLabel: { fontSize: 26, fontWeight: '500', color: colors.text },
});
