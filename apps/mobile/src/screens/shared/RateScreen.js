/**
 * Trip complete, and the review (design kit screen 35, spec §9).
 *
 * Two jobs on one screen, in this order:
 *
 *   1. **Tell them what to pay.** The trip has ended and cash has to change
 *      hands. That number is the first thing on the screen, in the largest
 *      type on it, because a passenger fumbling for notes should not have to
 *      go looking.
 *   2. **Take the review** — which is optional, and says so. A rating extracted
 *      under duress from someone who wants to get out of a car is not
 *      information.
 *
 * The blind window is the part worth defending. Neither side sees the other's
 * rating until both have submitted or 48 hours pass. Without it, one bad
 * rating gets answered with another and within a month every rating in the
 * system is a five.
 */

import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import {
  CUSTOMER_REVIEW_TAGS,
  DRIVER_REVIEW_TAGS,
  Timing,
  formatKina,
} from '@wantok/core';

import { Screen, ScreenHeader } from '../../components/Chrome';
import { Avatar, Card, Chip, StarPicker } from '../../components/Bits';
import Button from '../../components/Button';
import { TextField } from '../../components/Forms';
import { IS_DRIVER_APP } from '../../services/config';
import * as api from '../../services/supabase';
import { useApp } from '../../state/AppState';
import { useBookingFlow } from '../../state/BookingFlow';
import { colors, radius, spacing, type } from '../../theme';

export default function RateScreen({ navigation, route }) {
  const { bookingId } = route.params;
  const { profile } = useApp();
  const flow = useBookingFlow();

  const [booking, setBooking] = useState(null);
  const [subject, setSubject] = useState(null);
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState('');
  const [tags, setTags] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const tagOptions = IS_DRIVER_APP ? CUSTOMER_REVIEW_TAGS : DRIVER_REVIEW_TAGS;

  useEffect(() => {
    let alive = true;
    (async () => {
      const b = await api.getBooking(bookingId);
      if (!alive) return;
      setBooking(b);

      const who = IS_DRIVER_APP
        ? await api.getProfile(b.customer_id).catch(() => null)
        : await api.getDriverProfileForVehicle(b.vehicle_id).catch(() => null);
      if (alive) setSubject(who);
    })();
    return () => {
      alive = false;
    };
  }, [bookingId]);

  const done = () => {
    flow.reset?.();
    navigation.reset({ index: 0, routes: [{ name: 'Home' }] });
  };

  const submit = async () => {
    if (!stars) {
      setError('Choose a star rating, or skip this.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.submitReview({
        bookingId,
        subjectType: IS_DRIVER_APP ? 'CUSTOMER' : 'VEHICLE',
        subjectId: IS_DRIVER_APP ? booking.customer_id : booking.vehicle_id,
        stars,
        comment: comment.trim() || null,
        tags,
      });
      done();
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  if (!booking) return <Screen />;

  const total = booking.quoted_fare + (booking.service_fee ?? 0);

  return (
    <Screen>
      <ScreenHeader title="Trip complete" right={null} border={false} />

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        {/* The money first. */}
        <Card style={styles.fareCard}>
          <Text style={[type.caption, styles.muted]}>
            {IS_DRIVER_APP ? 'COLLECT FROM PASSENGER' : 'PAY YOUR DRIVER'}
          </Text>
          <Text style={styles.bigFare}>{formatKina(total)}</Text>
          <View style={styles.cashRow}>
            <Ionicons name="cash-outline" size={16} color={colors.textMuted} />
            <Text style={[type.small, styles.muted, { marginLeft: 6 }]}>
              Cash, direct to the driver. Wantok Ride does not handle the fare.
            </Text>
          </View>

          {IS_DRIVER_APP ? (
            <View style={styles.commissionRow}>
              <Text style={[type.small, styles.muted]}>
                Commission on this trip ({(booking.commission_amount / total * 100).toFixed(0)}%)
              </Text>
              <Text style={[type.bodyStrong, { color: colors.textMuted }]}>
                {formatKina(booking.commission_amount)}
              </Text>
            </View>
          ) : null}
        </Card>

        <View style={styles.subjectRow}>
          <Avatar name={subject?.full_name} uri={subject?.photo_url} size={64} />
          <Text style={[type.h2, styles.subjectName]}>{subject?.full_name}</Text>
          <Text style={[type.body, styles.muted]}>
            {IS_DRIVER_APP ? 'How was your passenger?' : 'How was your trip?'}
          </Text>
        </View>

        <StarPicker value={stars} onChange={setStars} />

        {stars > 0 ? (
          <>
            <View style={styles.tagWrap}>
              {tagOptions
                // Show praise for a good rating and problems for a poor one.
                // Offering "took a long route" beside five stars is noise.
                .filter((t) => (stars >= 4 ? t.positive : !t.positive))
                .map((t) => (
                  <Chip
                    key={t.code}
                    label={t.label}
                    selected={tags.includes(t.code)}
                    onPress={() =>
                      setTags((current) =>
                        current.includes(t.code)
                          ? current.filter((c) => c !== t.code)
                          : [...current, t.code],
                      )
                    }
                  />
                ))}
            </View>

            <TextField
              value={comment}
              onChangeText={setComment}
              placeholder="Anything else? (optional)"
              multiline
              numberOfLines={3}
              maxLength={500}
            />
          </>
        ) : null}

        <View style={styles.blindNote}>
          <Ionicons name="eye-off-outline" size={15} color={colors.textMuted} />
          <Text style={[type.small, styles.blindText]}>
            Neither of you sees the other’s rating until you have both rated, or{' '}
            {Timing.REVIEW_BLIND_HOURS} hours have passed.
          </Text>
        </View>

        {error ? <Text style={[type.small, styles.error]}>{error}</Text> : null}
      </ScrollView>

      <View style={styles.footer}>
        <Button label="Submit review" onPress={submit} loading={saving} disabled={!stars} />
        <Button label="Skip" variant="outline" onPress={done} style={{ marginTop: spacing.sm }} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { padding: spacing.xl, paddingBottom: spacing.xl },
  muted: { color: colors.textMuted },

  fareCard: { alignItems: 'center', backgroundColor: colors.goldFaint, borderColor: colors.gold },
  bigFare: { fontSize: 44, lineHeight: 52, fontWeight: '800', color: colors.text, marginVertical: 4 },
  cashRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.sm },
  commissionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    alignSelf: 'stretch',
    marginTop: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },

  subjectRow: { alignItems: 'center', marginTop: spacing.xxl, marginBottom: spacing.lg },
  subjectName: { marginTop: spacing.md },

  tagWrap: { flexDirection: 'row', flexWrap: 'wrap', marginTop: spacing.xl, marginBottom: spacing.md },

  blindNote: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  blindText: { flex: 1, marginLeft: spacing.sm, color: colors.textMuted },

  error: { color: colors.danger, textAlign: 'center', marginTop: spacing.md },

  footer: {
    padding: spacing.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
});
