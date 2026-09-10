/**
 * The fare breakdown (spec §5).
 *
 * Every dispute about money starts with "why is it this much", and the answer
 * should not require an engineer. This renders the same breakdown object the
 * fare engine produced at booking — base, distance, minimum, night, rounding —
 * so a passenger, a driver and an admin looking at a six-month-old trip all
 * see the identical explanation.
 *
 * On the driver's side, spec §5 rule 5 requires fare and commission as
 * **separate lines**. That is `showCommission`. A driver should never have to
 * work out what he keeps.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { explainQuote, formatKina } from '@wantok/core';
import { colors, radius, spacing, type } from '../theme';

export default function FareLines({ quote, showCommission = false, compact = false }) {
  const lines = explainQuote(quote, formatKina);

  return (
    <View style={styles.wrap}>
      {!compact &&
        lines.map((line, i) => (
          <View key={i} style={styles.line}>
            <View style={styles.lineLabel}>
              <Text style={type.body}>{line.label}</Text>
              {line.note ? <Text style={[type.small, styles.note]}>{line.note}</Text> : null}
            </View>
            <Text style={type.body}>{line.value}</Text>
          </View>
        ))}

      <View style={[styles.line, styles.total]}>
        <Text style={type.h3}>{showCommission ? 'Fare (cash from passenger)' : 'Total to pay'}</Text>
        <Text style={type.h2}>{formatKina(quote.total)}</Text>
      </View>

      {showCommission ? (
        <>
          <View style={styles.line}>
            <Text style={[type.body, styles.muted]}>
              Wantok Ride commission ({quote.commissionPct}%)
            </Text>
            <Text style={[type.body, styles.muted]}>−{formatKina(quote.commission)}</Text>
          </View>
          <View style={[styles.line, styles.net]}>
            <Text style={type.h3}>You keep</Text>
            <Text style={[type.h2, { color: colors.success }]}>{formatKina(quote.driverNet)}</Text>
          </View>
          <View style={styles.cashNote}>
            <Ionicons name="cash-outline" size={15} color={colors.textMuted} />
            <Text style={[type.small, styles.cashNoteText]}>
              The passenger pays you {formatKina(quote.total)} in cash. Commission is added to your
              vehicle balance and settled separately.
            </Text>
          </View>
        </>
      ) : (
        <View style={styles.cashNote}>
          <Ionicons name="cash-outline" size={15} color={colors.textMuted} />
          <Text style={[type.small, styles.cashNoteText]}>
            Pay the driver in cash. This price is locked and will not change, whatever the traffic
            does.
          </Text>
        </View>
      )}
    </View>
  );
}

/** The one-line version, for a list row or a trip header. */
export function FareBadge({ quote, label = 'FARE' }) {
  return (
    <View style={styles.badge}>
      <Text style={[type.caption, styles.badgeLabel]}>{label}</Text>
      <Text style={type.hero}>{formatKina(quote.total ?? quote)}</Text>
      {quote.isNight ? <Text style={[type.small, styles.badgeNight]}>Night rate applied</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: '100%' },
  line: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
  },
  lineLabel: { flex: 1, marginRight: spacing.md },
  note: { color: colors.grey, marginTop: 1 },
  muted: { color: colors.textMuted },
  total: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    marginTop: spacing.sm,
    paddingTop: spacing.md,
    alignItems: 'center',
  },
  net: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.md,
    alignItems: 'center',
  },
  cashNote: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  cashNoteText: { flex: 1, color: colors.textMuted, marginLeft: spacing.sm },

  badge: { alignItems: 'center' },
  badgeLabel: { color: colors.grey },
  badgeNight: { color: colors.textMuted, marginTop: 2 },
});
