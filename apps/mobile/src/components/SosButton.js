/**
 * SOS (spec §10).
 *
 * Held for 3 seconds to fire, to avoid pocket triggers. That is the whole
 * design constraint and everything here serves it:
 *
 *   - The progress ring is the only feedback that matters. Someone in trouble
 *     needs to know it is working *while* they hold it, not after.
 *   - Releasing early cancels, visibly, so an accidental brush is obviously
 *     harmless rather than ambiguous.
 *   - Haptics fire at the halfway point and on trigger, because the phone may
 *     well be against a leg or under a bag when this is pressed.
 *
 * It is the only red thing in the product. That is deliberate — see
 * `theme/colors.js`.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, Vibration, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Circle } from 'react-native-svg';

import { Timing } from '@wantok/core';
import { colors, type } from '../theme';

const SIZE = 76;
const STROKE = 5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export default function SosButton({ onTrigger, compact = false, style }) {
  const progress = useRef(new Animated.Value(0)).current;
  const [holding, setHolding] = useState(false);
  const halfway = useRef(false);
  const fired = useRef(false);

  const reset = useCallback(() => {
    progress.stopAnimation();
    Animated.timing(progress, {
      toValue: 0,
      duration: 180,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
    setHolding(false);
    halfway.current = false;
  }, [progress]);

  const start = useCallback(() => {
    if (fired.current) return;
    setHolding(true);
    halfway.current = false;

    const listener = progress.addListener(({ value }) => {
      if (!halfway.current && value >= 0.5) {
        halfway.current = true;
        Vibration.vibrate(20);
      }
    });

    Animated.timing(progress, {
      toValue: 1,
      duration: Timing.SOS_HOLD_MS,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start(({ finished }) => {
      progress.removeListener(listener);
      if (!finished) return;
      fired.current = true;
      // Three short pulses: unmistakable through a pocket, and distinct from
      // every other buzz the phone makes.
      Vibration.vibrate([0, 120, 80, 120, 80, 220]);
      onTrigger?.();
      // Allow a second trigger after a moment. Someone whose situation is
      // still deteriorating should not find the button dead.
      setTimeout(() => {
        fired.current = false;
        reset();
      }, 1500);
    });
  }, [onTrigger, progress, reset]);

  useEffect(() => () => progress.removeAllListeners(), [progress]);

  const dashoffset = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [CIRCUMFERENCE, 0],
  });

  return (
    <View style={[styles.wrap, style]}>
      <Pressable
        onPressIn={start}
        onPressOut={reset}
        accessibilityRole="button"
        accessibilityLabel="Emergency SOS"
        accessibilityHint="Hold for three seconds to alert Wantok Ride and your emergency contact"
        style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      >
        <Svg width={SIZE} height={SIZE} style={StyleSheet.absoluteFill}>
          <Circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            stroke="rgba(255,255,255,0.3)"
            strokeWidth={STROKE}
            fill="none"
          />
          <AnimatedCircle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            stroke={colors.white}
            strokeWidth={STROKE}
            fill="none"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={dashoffset}
            strokeLinecap="round"
            // Start the sweep at 12 o'clock rather than 3.
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          />
        </Svg>
        <Ionicons name="alert" size={26} color={colors.white} />
        <Text style={styles.label}>SOS</Text>
      </Pressable>

      {!compact && (
        <Text style={[type.caption, styles.hint]}>
          {holding ? 'KEEP HOLDING…' : 'HOLD 3 SECONDS'}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  button: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.danger,
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  pressed: { backgroundColor: colors.dangerDark },
  label: {
    color: colors.white,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
    marginTop: 1,
  },
  hint: { color: colors.textMuted, marginTop: 6 },
});
