/**
 * The small pieces: stars, avatars, pills, chips, empty states, section
 * headings and rows. Grouped in one file because none of them is big enough
 * to be worth hunting for, and they are almost always used together.
 */

import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { colors, radius, spacing, type } from '../theme';

// --- Stars ---------------------------------------------------------------

/**
 * A rating.
 *
 * `null` means no rating yet, and it must not read as zero stars — a new
 * driver with no history is not a bad driver, and a new passenger should not
 * be declined for having never ridden.
 */
export function Stars({ value, size = 14, showValue = true, count, newLabel = 'New' }) {
  if (value === null || value === undefined) {
    return <Text style={[type.small, styles.newLabel]}>{newLabel}</Text>;
  }
  return (
    <View style={styles.starRow}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Ionicons
          key={n}
          name={value >= n - 0.25 ? 'star' : value >= n - 0.75 ? 'star-half' : 'star-outline'}
          size={size}
          color={colors.gold}
        />
      ))}
      {showValue && (
        <Text style={[type.small, styles.starValue]}>
          {value.toFixed(1)}
          {count !== undefined ? ` (${count})` : ''}
        </Text>
      )}
    </View>
  );
}

/** Tappable stars, for leaving a review. */
export function StarPicker({ value, onChange, size = 40 }) {
  return (
    <View style={styles.starPicker}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Pressable
          key={n}
          onPress={() => onChange(n)}
          hitSlop={6}
          accessibilityRole="radio"
          accessibilityState={{ selected: value === n }}
          accessibilityLabel={`${n} star${n === 1 ? '' : 's'}`}
        >
          <Ionicons
            name={value >= n ? 'star' : 'star-outline'}
            size={size}
            color={value >= n ? colors.gold : colors.greyLight}
            style={{ marginHorizontal: 4 }}
          />
        </Pressable>
      ))}
    </View>
  );
}

// --- Avatar --------------------------------------------------------------

export function Avatar({ uri, name, size = 44, badge }) {
  const initials = (name ?? '?')
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

  return (
    <View>
      <View
        style={[
          styles.avatar,
          { width: size, height: size, borderRadius: size / 2 },
        ]}
      >
        {uri ? (
          <Image source={{ uri }} style={{ width: size, height: size, borderRadius: size / 2 }} />
        ) : (
          <Text style={[type.bodyStrong, { color: colors.white, fontSize: size * 0.36 }]}>{initials}</Text>
        )}
      </View>
      {badge ? (
        <View style={styles.avatarBadge}>
          <Ionicons name={badge} size={11} color={colors.onGold} />
        </View>
      ) : null}
    </View>
  );
}

// --- Pills and chips -----------------------------------------------------

const TONES = {
  neutral: { bg: colors.surfaceAlt, fg: colors.textMuted },
  gold: { bg: colors.goldSoft, fg: '#7A5C00' },
  success: { bg: colors.successSoft, fg: colors.success },
  warning: { bg: colors.warningSoft, fg: colors.warning },
  danger: { bg: colors.dangerSoft, fg: colors.danger },
  info: { bg: colors.harbourSoft, fg: colors.harbour },
  ink: { bg: colors.ink, fg: colors.white },
};

export function Pill({ label, tone = 'neutral', icon, style }) {
  const t = TONES[tone] ?? TONES.neutral;
  return (
    <View style={[styles.pill, { backgroundColor: t.bg }, style]}>
      {icon ? <Ionicons name={icon} size={12} color={t.fg} style={{ marginRight: 4 }} /> : null}
      <Text style={[type.caption, { color: t.fg }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export function Chip({ label, selected, onPress, icon }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: Boolean(selected) }}
      style={[styles.chip, selected && styles.chipOn]}
    >
      {icon ? (
        <Ionicons
          name={icon}
          size={14}
          color={selected ? colors.onGold : colors.textMuted}
          style={{ marginRight: 6 }}
        />
      ) : null}
      <Text style={[type.small, selected ? styles.chipLabelOn : styles.chipLabel]}>{label}</Text>
    </Pressable>
  );
}

// --- Structure -----------------------------------------------------------

export function SectionTitle({ children, action, onAction }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={[type.caption, styles.section]}>{children}</Text>
      {action ? (
        <Pressable onPress={onAction} hitSlop={8}>
          <Text style={[type.small, styles.sectionAction]}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Card({ children, style, onPress }) {
  const Wrapper = onPress ? Pressable : View;
  return (
    <Wrapper onPress={onPress} style={[styles.card, style]}>
      {children}
    </Wrapper>
  );
}

export function Row({ icon, title, detail, right, onPress, tone, last }) {
  const Wrapper = onPress ? Pressable : View;
  return (
    <Wrapper onPress={onPress} style={[styles.row, last && styles.rowLast]}>
      {icon ? (
        <View style={[styles.rowIcon, tone === 'danger' && { backgroundColor: colors.dangerSoft }]}>
          <Ionicons name={icon} size={17} color={tone === 'danger' ? colors.danger : colors.ink} />
        </View>
      ) : null}
      <View style={styles.rowBody}>
        <Text style={[type.bodyStrong, tone === 'danger' && { color: colors.danger }]} numberOfLines={1}>
          {title}
        </Text>
        {detail ? (
          <Text style={[type.small, styles.rowDetail]} numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
      </View>
      {right ?? (onPress ? <Ionicons name="chevron-forward" size={18} color={colors.greyLight} /> : null)}
    </Wrapper>
  );
}

/**
 * An empty state that says what to do next.
 *
 * "No vehicles available" on its own is a dead end. Whether the problem is
 * the hour, the seat count or the suburb decides whether someone waits ten
 * minutes or deletes the app.
 */
export function EmptyState({ icon = 'car-outline', title, message, action, onAction }) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Ionicons name={icon} size={26} color={colors.grey} />
      </View>
      <Text style={[type.h3, styles.emptyTitle]}>{title}</Text>
      {message ? <Text style={[type.body, styles.emptyMessage]}>{message}</Text> : null}
      {action ? (
        <Pressable onPress={onAction} style={styles.emptyAction}>
          <Text style={[type.bodyStrong, { color: colors.harbour }]}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** The dotted pickup → destination pair, used on every trip summary. */
export function RouteLine({ pickup, destination, compact }) {
  return (
    <View style={styles.routeWrap}>
      <View style={styles.routeRail}>
        <View style={styles.routeDot} />
        <View style={styles.routeStem} />
        <View style={styles.routeSquare} />
      </View>
      <View style={styles.routeLabels}>
        <View style={compact ? styles.routeLabelCompact : styles.routeLabel}>
          <Text style={[type.caption, styles.routeCap]}>PICK-UP</Text>
          <Text style={type.bodyStrong} numberOfLines={1}>{pickup}</Text>
        </View>
        <View style={[compact ? styles.routeLabelCompact : styles.routeLabel, styles.routeLabelLast]}>
          <Text style={[type.caption, styles.routeCap]}>DESTINATION</Text>
          <Text style={type.bodyStrong} numberOfLines={1}>{destination}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  starRow: { flexDirection: 'row', alignItems: 'center' },
  starValue: { marginLeft: 5, color: colors.textMuted },
  newLabel: { color: colors.harbour, fontWeight: '600' },
  starPicker: { flexDirection: 'row', justifyContent: 'center' },

  avatar: {
    backgroundColor: colors.inkLift,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.surface,
  },

  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },

  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    marginRight: spacing.sm,
    marginBottom: spacing.sm,
  },
  chipOn: { backgroundColor: colors.gold, borderColor: colors.gold },
  chipLabel: { color: colors.textMuted },
  chipLabelOn: { color: colors.onGold, fontWeight: '700' },

  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
    marginTop: spacing.lg,
  },
  section: { color: colors.grey },
  sectionAction: { color: colors.harbour, fontWeight: '600' },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowLast: { borderBottomWidth: 0 },
  rowIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  rowBody: { flex: 1, marginRight: spacing.sm },
  rowDetail: { color: colors.textMuted, marginTop: 2 },

  empty: { alignItems: 'center', paddingVertical: spacing.xxxl, paddingHorizontal: spacing.xl },
  emptyIcon: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  emptyTitle: { textAlign: 'center' },
  emptyMessage: { textAlign: 'center', color: colors.textMuted, marginTop: spacing.sm },
  emptyAction: { marginTop: spacing.lg },

  routeWrap: { flexDirection: 'row' },
  routeRail: { alignItems: 'center', width: 20, paddingTop: 20 },
  routeDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.ink },
  routeStem: { flex: 1, width: 2, backgroundColor: colors.border, marginVertical: 3 },
  routeSquare: { width: 10, height: 10, backgroundColor: colors.gold },
  routeLabels: { flex: 1 },
  routeLabel: { paddingBottom: spacing.lg },
  routeLabelCompact: { paddingBottom: spacing.md },
  routeLabelLast: { paddingBottom: 0 },
  routeCap: { color: colors.grey, marginBottom: 2 },
});
