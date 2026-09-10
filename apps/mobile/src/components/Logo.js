/**
 * The Wantok Ride mark.
 *
 * ⚠ A stand-in, built to the right proportions so layouts are honest. Branding
 * is open decision #1 in the spec — when the real mark arrives, replace the
 * SVG in `Mark` and nothing else needs to change.
 *
 * The idea it is drawing: *wantok* is Tok Pisin for "one talk" — the people
 * who speak your language, your kin, the ones you can rely on. So the mark is
 * two points joined by a road, not a car. The product is not a taxi; it is the
 * connection between two people who then travel together.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { colors, type } from '../theme';

export function Mark({ size = 56, tone = 'gold' }) {
  const ground = tone === 'gold' ? colors.gold : colors.white;
  const ink = tone === 'gold' ? colors.ink : colors.ink;

  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Circle cx={32} cy={32} r={32} fill={ground} />
      {/* The road: a single stroke bending between the two points. */}
      <Path
        d="M 18 46 C 18 34, 46 30, 46 18"
        stroke={ink}
        strokeWidth={5}
        strokeLinecap="round"
        fill="none"
      />
      {/* The two wantoks. */}
      <Circle cx={18} cy={46} r={7} fill={ink} />
      <Circle cx={46} cy={18} r={7} fill={ink} />
      <Circle cx={18} cy={46} r={2.6} fill={ground} />
      <Circle cx={46} cy={18} r={2.6} fill={ground} />
    </Svg>
  );
}

export default function Logo({ size = 56, light = false, stacked = true, tagline }) {
  return (
    <View style={stacked ? styles.stacked : styles.inline}>
      <Mark size={size} tone={light ? 'gold' : 'gold'} />
      <View style={stacked ? styles.stackedText : styles.inlineText}>
        <Text
          style={[
            type.hero,
            styles.word,
            { fontSize: size * 0.52, lineHeight: size * 0.6, color: light ? colors.white : colors.ink },
          ]}
        >
          Wantok<Text style={{ color: colors.gold }}> Ride</Text>
        </Text>
        {tagline ? (
          <Text style={[type.small, styles.tagline, light && { color: 'rgba(255,255,255,0.78)' }]}>
            {tagline}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stacked: { alignItems: 'center' },
  inline: { flexDirection: 'row', alignItems: 'center' },
  stackedText: { alignItems: 'center', marginTop: 14 },
  inlineText: { marginLeft: 12 },
  word: { letterSpacing: -0.5 },
  tagline: { color: colors.textMuted, marginTop: 4, letterSpacing: 1.5 },
});
