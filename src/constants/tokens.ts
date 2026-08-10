import { Platform } from 'react-native';
import { Easing } from 'react-native-reanimated';

/**
 * Versutus design tokens — dark-only (decision 2026-08-10, see
 * docs/roadmap-capability-ui-overhaul.md). `Palette` is the single source of
 * truth. Feature components should consume it via `useTokens()`; primitives
 * under components/ui may import `Palette` directly.
 */
export const Palette = {
  // Elevation ramp: base → inset (recessed) → elevated (cards) → raised (sheets/heroes)
  background: '#030304',
  backgroundInset: '#070607',
  backgroundElevated: '#0A0908',
  backgroundRaised: '#100E0B',

  // Glass tiers
  glass: 'rgba(14, 12, 10, 0.78)',
  glassBorder: 'rgba(229, 198, 126, 0.18)',
  glassHighlight: 'rgba(255, 236, 190, 0.075)',
  glassHero: 'rgba(22, 18, 14, 0.88)',
  glassHeroBorder: 'rgba(240, 214, 144, 0.32)',

  // Text
  textPrimary: '#F7F1E3',
  textSecondary: '#B8AE9A',
  textTertiary: '#7F7668',
  textInverse: '#070503',

  // Accent
  accent: '#D6B76A',
  accentMuted: 'rgba(214, 183, 106, 0.18)',
  accentWarm: '#F0D690',
  accentWarmMuted: 'rgba(240, 214, 144, 0.16)',

  // Status
  statusConnected: '#63D7A6',
  statusConnectedMuted: 'rgba(99, 215, 166, 0.16)',
  statusConnecting: '#D6B76A',
  statusDisconnected: '#E56D6D',
  statusDisconnectedMuted: 'rgba(229, 109, 109, 0.16)',
  statusPairing: '#F0D690',

  // Borders & scrim
  border: 'rgba(229, 198, 126, 0.12)',
  borderSubtle: 'rgba(229, 198, 126, 0.08)',
  borderStrong: 'rgba(240, 214, 144, 0.28)',
  overlay: 'rgba(0, 0, 0, 0.62)',
} as const;

export type SemanticPalette = {
  [K in keyof typeof Palette]: string;
};
export type SemanticColor = keyof SemanticPalette;

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const Radius = {
  xs: 6,
  sm: 8,
  md: 10,
  lg: 14,
  xl: 18,
  xxl: 24,
  full: 999,
} as const;

export const Elevation = {
  glass: 0,
  card: 4,
  modal: 12,
} as const;

export const Motion = {
  duration: {
    fast: 150,
    normal: 300,
    slow: 600,
  },
  easing: {
    standard: Easing.bezier(0.2, 0, 0, 1),
    decelerate: Easing.bezier(0, 0, 0.2, 1),
    accelerate: Easing.bezier(0.4, 0, 1, 1),
    spring: Easing.elastic(0.7),
  },
} as const;

export const Typography = {
  display: { fontSize: 40, lineHeight: 44, fontWeight: '600' as const, letterSpacing: 0 },
  title: { fontSize: 28, lineHeight: 34, fontWeight: '600' as const, letterSpacing: 0 },
  headline: { fontSize: 20, lineHeight: 26, fontWeight: '600' as const, letterSpacing: 0 },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '500' as const, letterSpacing: 0 },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '500' as const, letterSpacing: 0 },
  micro: { fontSize: 11, lineHeight: 14, fontWeight: '500' as const, letterSpacing: 0.4 },
  mono: { fontSize: 12, lineHeight: 18, fontWeight: '500' as const },
} as const;

export const FontFamily = {
  sans: 'InstrumentSans_500Medium',
  sansSemiBold: 'InstrumentSans_600SemiBold',
  sansBold: 'InstrumentSans_700Bold',
  mono: 'JetBrainsMono_500Medium',
  monoBold: 'JetBrainsMono_700Bold',
} as const;

export const Fonts = Platform.select({
  ios: {
    sans: FontFamily.sans,
    serif: 'ui-serif',
    rounded: 'ui-rounded',
    mono: FontFamily.mono,
  },
  default: {
    sans: FontFamily.sans,
    serif: 'serif',
    rounded: FontFamily.sans,
    mono: FontFamily.mono,
  },
  web: {
    sans: 'Instrument Sans, var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'Instrument Sans, var(--font-rounded)',
    mono: 'JetBrains Mono, var(--font-mono)',
  },
});
