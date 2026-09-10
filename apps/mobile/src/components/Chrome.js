/**
 * Screen chrome: headers, bottom sheets, the photo hero, and the connection
 * banner.
 *
 * Android has been edge-to-edge by default since Expo SDK 54, so every screen
 * has to account for the navigation bar itself. `Screen` and `Sheet` do that
 * once, here, rather than in forty files that each get it slightly wrong.
 */

import React from 'react';
import { ImageBackground, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, gradients, radius, shadow, spacing, type } from '../theme';

/** The standard page: safe areas top and bottom, an off-white ground. */
export function Screen({ children, style, edges = ['top', 'bottom'], dark }) {
  return (
    <SafeAreaView
      edges={edges}
      style={[styles.screen, dark && { backgroundColor: colors.ink }, style]}
    >
      {children}
    </SafeAreaView>
  );
}

export function ScreenHeader({ title, subtitle, onBack, right, dark, border = true }) {
  return (
    <View style={[styles.header, border && styles.headerBorder, dark && styles.headerDark]}>
      {onBack ? (
        <Pressable onPress={onBack} hitSlop={12} style={styles.back} accessibilityLabel="Go back">
          <Ionicons name="chevron-back" size={26} color={dark ? colors.white : colors.text} />
        </Pressable>
      ) : (
        <View style={styles.back} />
      )}
      <View style={styles.headerBody}>
        {title ? (
          <Text style={[type.h3, dark && { color: colors.white }]} numberOfLines={1}>
            {title}
          </Text>
        ) : null}
        {subtitle ? (
          <Text style={[type.small, styles.headerSub, dark && { color: 'rgba(255,255,255,0.7)' }]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <View style={styles.headerRight}>{right}</View>
    </View>
  );
}

/**
 * A hero photograph with scrims top and bottom.
 *
 * The brand plates are bright tropical daylight — open sky, white hulls, pale
 * road. White text on them is unreadable without a scrim, and a flat overlay
 * muddies the photograph. Two gradients keep the middle of the image clean
 * and darken only where type actually sits.
 */
export function PhotoHero({ source, children, top = true, bottom = true, style }) {
  return (
    <ImageBackground source={source} style={[styles.hero, style]} resizeMode="cover">
      {top ? <LinearGradient colors={gradients.heroTop} style={styles.scrimTop} pointerEvents="none" /> : null}
      {bottom ? (
        <LinearGradient colors={gradients.heroBottom} style={styles.scrimBottom} pointerEvents="none" />
      ) : null}
      {children}
    </ImageBackground>
  );
}

/**
 * A bottom sheet.
 *
 * `insets.bottom` is added to the footer padding rather than relying on
 * SafeAreaView, because the sheet is a Modal and sits outside the screen's
 * safe area. Without it the primary button lands under the Android nav bar.
 */
export function Sheet({ visible, onClose, title, subtitle, children, footer, scroll = true, maxHeight = 0.86 }) {
  const insets = useSafeAreaInsets();
  const Body = scroll ? ScrollView : View;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, { maxHeight: `${maxHeight * 100}%` }]}>
        <View style={styles.grabber} />
        {title ? (
          <View style={styles.sheetHead}>
            <View style={{ flex: 1 }}>
              <Text style={type.h2}>{title}</Text>
              {subtitle ? <Text style={[type.small, styles.sheetSub]}>{subtitle}</Text> : null}
            </View>
            {onClose ? (
              <Pressable onPress={onClose} hitSlop={12} accessibilityLabel="Close">
                <Ionicons name="close" size={24} color={colors.grey} />
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <Body
          style={styles.sheetBody}
          contentContainerStyle={scroll ? styles.sheetContent : undefined}
          showsVerticalScrollIndicator={false}
        >
          {children}
        </Body>

        {footer ? (
          <View style={[styles.sheetFooter, { paddingBottom: spacing.lg + insets.bottom }]}>{footer}</View>
        ) : (
          <View style={{ height: insets.bottom }} />
        )}
      </View>
    </Modal>
  );
}

/**
 * Connection state (spec §14).
 *
 * "The customer app must clearly show 'searching' versus 'no connection'.
 * They are different problems and the user needs to know which one they have."
 * A spinner that means both is the thing this exists to prevent.
 */
export function ConnectionBanner({ state, pending = 0, onRetry }) {
  if (state === 'online' && !pending) return null;

  const config = {
    searching: { icon: 'search', tone: colors.harbour, bg: colors.harbourSoft, text: 'Searching for vehicles…' },
    offline: {
      icon: 'cloud-offline',
      tone: colors.danger,
      bg: colors.dangerSoft,
      text: 'No connection. You cannot book until this clears.',
    },
    syncing: { icon: 'sync', tone: colors.warning, bg: colors.warningSoft, text: `Syncing ${pending} action${pending === 1 ? '' : 's'}…` },
  }[state] ?? null;

  if (!config) return null;

  return (
    <Pressable onPress={onRetry} style={[styles.banner, { backgroundColor: config.bg }]}>
      <Ionicons name={config.icon} size={15} color={config.tone} />
      <Text style={[type.small, { color: config.tone, marginLeft: spacing.sm, flex: 1 }]}>{config.text}</Text>
      {onRetry && state === 'offline' ? (
        <Text style={[type.small, { color: config.tone, fontWeight: '700' }]}>RETRY</Text>
      ) : null}
    </Pressable>
  );
}

/** A floating card that sits over the map. */
export function FloatingCard({ children, style }) {
  return <View style={[styles.floating, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
  },
  headerDark: { backgroundColor: colors.ink },
  headerBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  back: { width: 34, alignItems: 'flex-start' },
  headerBody: { flex: 1, alignItems: 'center' },
  headerSub: { color: colors.textMuted },
  headerRight: { minWidth: 34, alignItems: 'flex-end' },

  hero: { flex: 1, justifyContent: 'flex-end' },
  scrimTop: { position: 'absolute', top: 0, left: 0, right: 0, height: '42%' },
  scrimBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, height: '58%' },

  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.scrim },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    ...shadow.sheet,
  },
  grabber: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    alignSelf: 'center',
    marginTop: spacing.sm,
  },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  sheetSub: { color: colors.textMuted, marginTop: 2 },
  sheetBody: { paddingHorizontal: spacing.xl },
  sheetContent: { paddingBottom: spacing.lg },
  sheetFooter: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },

  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },

  floating: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    ...shadow.card,
  },
});
