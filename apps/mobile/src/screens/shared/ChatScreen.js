/**
 * In-app chat (design kit screen 33, spec §11).
 *
 * Deliberately thin. Text only — no images, no voice notes, no typing
 * indicators, no read receipts beyond a plain tick. Data costs money in Papua
 * New Guinea and a typing indicator is a stream of packets that tells nobody
 * anything they needed.
 *
 * Quick replies do most of the work. They cover the four things anyone
 * actually says in a taxi conversation, they cost one tap instead of twenty,
 * and they work for a passenger whose English is their third language.
 *
 * The window closes 24 hours after the trip ends, enforced by RLS. When it is
 * shut this screen is read-only rather than gone — the conversation is
 * evidence in a dispute and the passenger should still be able to see it.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { QUICK_REPLIES, chatWindowOpen } from '@wantok/core';

import { Screen, ScreenHeader } from '../../components/Chrome';
import { Avatar } from '../../components/Bits';
import { IS_DRIVER_APP } from '../../services/config';
import * as api from '../../services/supabase';
import { useApp } from '../../state/AppState';
import { colors, radius, spacing, type } from '../../theme';

export default function ChatScreen({ navigation, route }) {
  const { bookingId } = route.params;
  const { profile } = useApp();

  const [booking, setBooking] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [other, setOther] = useState(null);
  const listRef = useRef(null);

  useEffect(() => {
    let alive = true;

    (async () => {
      const [b, m] = await Promise.all([api.getBooking(bookingId), api.getMessages(bookingId)]);
      if (!alive) return;
      setBooking(b);
      setMessages(m);

      const contacts = await api.getBookingContacts(bookingId).catch(() => null);
      if (alive && contacts) {
        setOther(
          IS_DRIVER_APP
            ? { name: contacts.customer_name }
            : { name: contacts.driver_name },
        );
      }
    })();

    const unwatch = api.watchMessages(bookingId, (message) => {
      setMessages((current) =>
        current.some((m) => m.id === message.id) ? current : [...current, message],
      );
    });

    return () => {
      alive = false;
      unwatch();
    };
  }, [bookingId]);

  const send = useCallback(
    async (body) => {
      const text = body.trim();
      if (!text) return;
      setDraft('');

      // Optimistic: the message appears immediately and is reconciled by the
      // realtime insert. On a slow connection, waiting for a round trip before
      // showing your own message reads as the app being broken.
      const optimistic = {
        id: `local-${Date.now()}`,
        booking_id: bookingId,
        sender_id: profile.id,
        body: text,
        sent_at: new Date().toISOString(),
        pending: true,
      };
      setMessages((current) => [...current, optimistic]);

      try {
        await api.sendMessage(bookingId, profile.id, text);
      } catch {
        setMessages((current) =>
          current.map((m) => (m.id === optimistic.id ? { ...m, failed: true, pending: false } : m)),
        );
      }
    },
    [bookingId, profile],
  );

  const open = booking ? chatWindowOpen(booking) : true;
  const quickReplies = QUICK_REPLIES[IS_DRIVER_APP ? 'DRIVER' : 'CUSTOMER'];

  return (
    <Screen edges={['top']}>
      <ScreenHeader
        title={other?.name ?? 'Messages'}
        subtitle={booking?.reference}
        onBack={navigation.goBack}
      />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
      >
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={styles.list}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          ListEmptyComponent={
            <Text style={[type.small, styles.hint]}>
              Messages are kept with the booking and can be read by Wantok Ride if there is a
              dispute.
            </Text>
          }
          renderItem={({ item }) => {
            const mine = item.sender_id === profile.id;
            return (
              <View style={[styles.bubbleRow, mine && styles.bubbleRowMine]}>
                <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
                  <Text style={[type.body, mine && { color: colors.onGold }]}>{item.body}</Text>
                  <View style={styles.bubbleMeta}>
                    <Text style={[type.caption, mine ? styles.metaMine : styles.metaTheirs]}>
                      {new Date(item.sent_at).toLocaleTimeString('en-AU', {
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </Text>
                    {item.failed ? (
                      <Ionicons name="alert-circle" size={12} color={colors.danger} style={styles.tick} />
                    ) : item.pending ? (
                      <Ionicons name="time-outline" size={11} color={colors.onGold} style={styles.tick} />
                    ) : mine ? (
                      <Ionicons name="checkmark" size={12} color={colors.onGold} style={styles.tick} />
                    ) : null}
                  </View>
                </View>
              </View>
            );
          }}
        />

        {open ? (
          <>
            <View style={styles.quickRow}>
              <FlatList
                data={quickReplies}
                horizontal
                showsHorizontalScrollIndicator={false}
                keyExtractor={(q) => q}
                contentContainerStyle={styles.quickList}
                renderItem={({ item }) => (
                  <Pressable style={styles.quick} onPress={() => send(item)}>
                    <Text style={type.small}>{item}</Text>
                  </Pressable>
                )}
              />
            </View>

            <View style={styles.composer}>
              <TextInput
                value={draft}
                onChangeText={setDraft}
                placeholder="Type a message…"
                placeholderTextColor={colors.greyLight}
                style={[type.body, styles.input]}
                maxLength={1000}
                multiline
              />
              <Pressable
                onPress={() => send(draft)}
                disabled={!draft.trim()}
                style={[styles.send, !draft.trim() && styles.sendOff]}
                accessibilityLabel="Send"
              >
                <Ionicons name="send" size={18} color={colors.onGold} />
              </Pressable>
            </View>
          </>
        ) : (
          <View style={styles.closed}>
            <Ionicons name="lock-closed-outline" size={15} color={colors.grey} />
            <Text style={[type.small, styles.closedText]}>
              This conversation closed 24 hours after the trip ended.
            </Text>
          </View>
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { padding: spacing.lg, paddingBottom: spacing.xl },
  hint: { color: colors.grey, textAlign: 'center', marginTop: spacing.xxl, paddingHorizontal: spacing.xl },

  bubbleRow: { flexDirection: 'row', marginBottom: spacing.sm },
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubble: { maxWidth: '78%', borderRadius: radius.lg, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  bubbleMine: { backgroundColor: colors.gold, borderBottomRightRadius: 4 },
  bubbleTheirs: { backgroundColor: colors.surface, borderBottomLeftRadius: 4, borderWidth: 1, borderColor: colors.border },
  bubbleMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', marginTop: 2 },
  metaMine: { color: 'rgba(36,28,0,0.6)' },
  metaTheirs: { color: colors.grey },
  tick: { marginLeft: 3 },

  quickRow: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  quickList: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  quick: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginRight: spacing.sm,
  },

  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  input: {
    flex: 1,
    maxHeight: 110,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
  },
  send: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.sm,
  },
  sendOff: { opacity: 0.4 },

  closed: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  closedText: { color: colors.grey, marginLeft: spacing.sm },
});
