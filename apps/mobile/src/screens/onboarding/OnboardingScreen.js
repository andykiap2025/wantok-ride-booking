/**
 * Onboarding (design kit screens 3–6).
 *
 * Four slides, and the second one is the whole product: **you choose the
 * vehicle**. Every other ride-hailing app in the world assigns you a car. The
 * source design kit already had "Vehicle Selection — users have the liberty to
 * choose the type of vehicle as per their need", which is a happy accident,
 * because for Wantok Ride that is not a feature note, it is the business model.
 *
 * The photography is Port Moresby, deliberately. An onboarding carousel of
 * generic illustrated cityscapes tells a Papua New Guinean user that this app
 * was built for somewhere else.
 */

import React, { useRef, useState } from 'react';
import { Dimensions, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import Button from '../../components/Button';
import { PhotoHero } from '../../components/Chrome';
import { colors, spacing, type } from '../../theme';

const { width } = Dimensions.get('window');

const SLIDES = [
  {
    key: 'request',
    title: 'Request a ride',
    body: 'Set where you are and where you are going. Wantok Ride shows you every approved vehicle nearby.',
    image: require('../../../assets/backgrounds/onboard-ride.jpg'),
  },
  {
    key: 'choose',
    title: 'You choose the vehicle',
    body: 'See the car, the driver, the rating and the exact fare before you book. Nobody assigns you a ride.',
    image: require('../../../assets/backgrounds/onboard-vehicle.jpg'),
  },
  {
    key: 'track',
    title: 'One price, locked',
    body: 'The fare is fixed the moment you book and paid in cash. Traffic and detours do not change it.',
    image: require('../../../assets/backgrounds/onboard-track.jpg'),
  },
  {
    key: 'share',
    title: 'Share your trip',
    body: 'Send a live tracking link to family, and hold SOS for three seconds if anything goes wrong.',
    image: require('../../../assets/backgrounds/onboard-share.jpg'),
  },
];

export default function OnboardingScreen({ navigation }) {
  const [index, setIndex] = useState(0);
  const listRef = useRef(null);
  const insets = useSafeAreaInsets();
  const last = index === SLIDES.length - 1;

  const finish = () => navigation.replace('Welcome');

  const next = () => {
    if (last) return finish();
    listRef.current?.scrollToIndex({ index: index + 1, animated: true });
    return undefined;
  };

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <FlatList
        ref={listRef}
        data={SLIDES}
        keyExtractor={(s) => s.key}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(e) =>
          setIndex(Math.round(e.nativeEvent.contentOffset.x / width))
        }
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        renderItem={({ item }) => (
          <PhotoHero source={item.image} style={{ width }}>
            <View style={[styles.copy, { paddingTop: insets.top + spacing.xxl }]}>
              <Text style={[type.hero, styles.title]}>{item.title}</Text>
              <Text style={[type.body, styles.body]}>{item.body}</Text>
            </View>
          </PhotoHero>
        )}
      />

      <View style={[styles.controls, { paddingBottom: insets.bottom + spacing.lg }]}>
        <Pressable onPress={finish} hitSlop={12} accessibilityRole="button">
          <Text style={[type.bodyStrong, styles.skip]}>{last ? '' : 'Skip'}</Text>
        </Pressable>

        <View style={styles.dots}>
          {SLIDES.map((s, i) => (
            <View key={s.key} style={[styles.dot, i === index && styles.dotOn]} />
          ))}
        </View>

        <Button
          label={last ? 'Get started' : 'Next'}
          onPress={next}
          full={false}
          small
          style={styles.next}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink },
  copy: { paddingHorizontal: spacing.xl, position: 'absolute', top: 0, left: 0, right: 0 },
  title: { color: colors.white },
  body: { color: 'rgba(255,255,255,0.88)', marginTop: spacing.md, maxWidth: 320 },

  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    backgroundColor: colors.ink,
  },
  skip: { color: 'rgba(255,255,255,0.7)', width: 44 },
  dots: { flexDirection: 'row' },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.32)',
    marginHorizontal: 4,
  },
  dotOn: { backgroundColor: colors.gold, width: 20 },
  next: { minWidth: 108 },
});
