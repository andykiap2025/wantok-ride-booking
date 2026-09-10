/**
 * The accept countdown (spec §7).
 *
 * 90 seconds on the driver's side of an immediate booking, and the same clock
 * shown to the customer while they wait. Both sides watch the same number,
 * which matters: a passenger who can see the driver has 40 seconds left is
 * waiting for something, rather than wondering if the app is broken.
 *
 * The clock is derived from the booking's own timestamps, never from a
 * counter this component owns. Backgrounding the app, a late push arriving,
 * or a screen remounting must not add time to a window the server is going to
 * close on schedule.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { acceptDeadline, secondsToAccept } from '@wantok/core';
import { colors, type } from '../theme';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export default function Countdown({
  booking,
  size = 96,
  stroke = 7,
  onExpire,
  label = 'to respond',
}) {
  const total = useMemo(() => {
    const start = new Date(booking.requested_at ?? booking.created_at).getTime();
    return Math.max(1, (acceptDeadline(booking).getTime() - start) / 1000);
  }, [booking]);

  const [remaining, setRemaining] = useState(() => secondsToAccept(booking));
  const expired = useRef(false);

  useEffect(() => {
    expired.current = false;
    const tick = () => {
      const left = secondsToAccept(booking);
      setRemaining(left);
      if (left <= 0 && !expired.current) {
        expired.current = true;
        onExpire?.();
      }
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [booking, onExpire]);

  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = Math.max(0, Math.min(1, remaining / total));

  // Under ten seconds the ring turns red. It is the one place outside SOS and
  // destructive actions where red is allowed, because "you are about to lose
  // this booking" is exactly the meaning red is reserved for.
  const urgent = remaining <= 10;
  const tint = urgent ? colors.danger : colors.gold;

  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!urgent) {
      pulse.setValue(1);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.06, duration: 400, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 400, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [urgent, pulse]);

  return (
    <Animated.View style={[styles.wrap, { width: size, height: size, transform: [{ scale: pulse }] }]}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={size / 2} cy={size / 2} r={radius} stroke={colors.border} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={tint}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <View style={styles.centre}>
        <Text style={[type.h2, { color: urgent ? colors.danger : colors.text }]}>
          {Math.ceil(remaining)}
        </Text>
        <Text style={[type.caption, styles.label]}>{label}</Text>
      </View>
    </Animated.View>
  );
}

/** The same clock as a thin bar, for a list row or a sheet header. */
export function CountdownBar({ booking, onExpire }) {
  const total = useMemo(() => {
    const start = new Date(booking.requested_at ?? booking.created_at).getTime();
    return Math.max(1, (acceptDeadline(booking).getTime() - start) / 1000);
  }, [booking]);

  const [remaining, setRemaining] = useState(() => secondsToAccept(booking));
  const fired = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => {
      const left = secondsToAccept(booking);
      setRemaining(left);
      if (left <= 0 && !fired.current) {
        fired.current = true;
        onExpire?.();
      }
    }, 250);
    return () => clearInterval(timer);
  }, [booking, onExpire]);

  const fraction = Math.max(0, Math.min(1, remaining / total));
  return (
    <View style={styles.bar}>
      <View
        style={[
          styles.barFill,
          { width: `${fraction * 100}%`, backgroundColor: remaining <= 10 ? colors.danger : colors.gold },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  centre: { alignItems: 'center' },
  label: { color: colors.grey, marginTop: -2 },
  bar: { height: 4, backgroundColor: colors.border, borderRadius: 2, overflow: 'hidden' },
  barFill: { height: 4, borderRadius: 2 },
});
