import { Platform } from 'react-native';
import { Easing } from 'react-native-reanimated';

/**
 * Versutus design tokens — dark-only (decision 2026-08-10, see
 * docs/roadmap-capability-ui-overhaul.md). `Palette` is the single source of
 * truth. Feature components should consume it via `useTokens()`; primitives
 * under components/ui may import `Palette` directly.
 *
 * Visual language per docs/visual-direction-2026-09.md (ACCEPTED): cool
 * near-black stage, bright cool-white type, soft electric violet brand accent,
 * metallic gold as a rare highlight only (never the brand accent).
 */
export const Palette = {
  // Elevation ramp: base → inset → elevated → raised. Steps are wide enough that
  // cards read without hairlines (S4 / visual-direction). Cool near-black stage.
  background: '#0A0A0B',
  backgroundInset: '#101012',
  backgroundElevated: '#141416',
  backgroundRaised: '#1C1C20',

  // Glass tiers (cool translucent; flat-panel + hairline first)
  glass: 'rgba(20, 20, 22, 0.82)',
  glassBorder: 'rgba(245, 247, 250, 0.08)',
  glassHighlight: 'rgba(245, 247, 250, 0.04)',
  glassHero: 'rgba(28, 28, 32, 0.92)',
  glassHeroBorder: 'rgba(245, 247, 250, 0.12)',

  // Text — bright cool white / cool gray
  textPrimary: '#F5F7FA',
  textSecondary: '#9CA3AF',
  textTertiary: '#8A8F98',
  textInverse: '#0A0A0B',

  // Accent — soft electric violet is the brand; `accentWarm` is the brighter
  // violet for selected/focus states (was gold-as-primary).
  accent: '#8B7CFF',
  accentMuted: 'rgba(139, 124, 255, 0.18)',
  accentWarm: '#A79BFF',
  accentWarmMuted: 'rgba(167, 155, 255, 0.16)',

  // Metallic gold — luxury punch only. Rare highlight roles, never `accent`.
  gold: '#D4AF37',
  goldMuted: 'rgba(212, 175, 55, 0.16)',

  // Status (semantic — greens/ambers/reds, not brand)
  statusConnected: '#63D7A6',
  statusConnectedMuted: 'rgba(99, 215, 166, 0.16)',
  statusConnecting: '#D6B76A',
  statusDisconnected: '#E56D6D',
  statusDisconnectedMuted: 'rgba(229, 109, 109, 0.16)',
  statusPairing: '#F0D690',

  // Borders & scrim (cool hairlines)
  border: 'rgba(245, 247, 250, 0.08)',
  borderSubtle: 'rgba(245, 247, 250, 0.05)',
  borderStrong: 'rgba(245, 247, 250, 0.18)',
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
  display: { fontSize: 40, lineHeight: 44, fontWeight: '600' as const, letterSpacing: -0.8 },
  title: { fontSize: 28, lineHeight: 34, fontWeight: '600' as const, letterSpacing: -0.5 },
  headline: { fontSize: 20, lineHeight: 26, fontWeight: '600' as const, letterSpacing: -0.3 },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' as const, letterSpacing: 0 },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '500' as const, letterSpacing: 0 },
  micro: { fontSize: 11, lineHeight: 14, fontWeight: '500' as const, letterSpacing: 0.4 },
  mono: { fontSize: 12, lineHeight: 18, fontWeight: '500' as const },
} as const;

export const FontFamily = {
  sansRegular: 'InstrumentSans_400Regular',
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
