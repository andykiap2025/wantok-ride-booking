import { Platform } from 'react-native';

const family = Platform.select({
  ios: { regular: 'System', medium: 'System', bold: 'System' },
  android: {
    regular: 'sans-serif',
    medium: 'sans-serif-medium',
    bold: 'sans-serif',
  },
  default: { regular: 'System', medium: 'System', bold: 'System' },
});

export const type = {
  hero: { fontSize: 32, lineHeight: 38, fontWeight: '800', fontFamily: family.bold },
  h1: { fontSize: 28, lineHeight: 34, fontWeight: '800', fontFamily: family.bold },
  h2: { fontSize: 22, lineHeight: 28, fontWeight: '700', fontFamily: family.bold },
  h3: { fontSize: 17, lineHeight: 22, fontWeight: '700', fontFamily: family.medium },
  body: { fontSize: 15, lineHeight: 21, fontWeight: '400', fontFamily: family.regular },
  bodyStrong: { fontSize: 15, lineHeight: 21, fontWeight: '600', fontFamily: family.medium },
  small: { fontSize: 13, lineHeight: 18, fontWeight: '400', fontFamily: family.regular },
  caption: { fontSize: 11, lineHeight: 15, fontWeight: '600', fontFamily: family.medium, letterSpacing: 0.6 },
  button: { fontSize: 16, lineHeight: 20, fontWeight: '700', fontFamily: family.bold, letterSpacing: 0.3 },
};
