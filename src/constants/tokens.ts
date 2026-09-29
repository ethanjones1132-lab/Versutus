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
 * metallic gold as a rare highlight only (never the brand accent). The
 * Nocturne pass (docs/design-language-nocturne-2026-09.md) widens the
 * elevation steps, adds the specular edge floating surfaces carry, and sets
 * titles in Instrument Serif.
 */
export const Palette = {
  // Elevation ramp: base → inset → elevated → raised. Steps are wide enough that
  // cards read without hairlines (S4 / visual-direction). Cool near-black stage.
  background: '#0A0A0B',
  backgroundInset: '#111114',
  backgroundElevated: '#18181C',
  backgroundRaised: '#222228',
  // The one edge a floating surface (sheet, menu, composer) carries: light
  // catching its top lip. Cards resting on the stage carry nothing.
  specular: 'rgba(255, 255, 255, 0.07)',
  // Smoked glass for a control resting in the lamp's light (the roster's
  // search): it dims the light behind it instead of punching a hole in it.
  // Dark enough that tertiary text keeps AA over the brightest stage pixel.
  stageGlass: 'rgba(14, 14, 18, 0.58)',
  // A panel resting on the stage (row groups, cards): over the dark stage it
  // composites to the elevated step, #18181C; under the lamp the light glows
  // through it, so the room's light reaches the UI and not only the backdrop.
  // Tertiary text keeps AA over it under every lamp colour (glass-variants-test).
  stagePanel: 'rgba(28, 28, 34, 0.72)',
  // The current item in a list inside a sheet: a soft lift of light, with a
  // violet light bar at its edge — light, never a violet fill.
  rowSelected: 'rgba(245, 247, 250, 0.07)',

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
  // The deep end of the violet orb's gradient (send, primary buttons) and the
  // glow it casts. Light, never paint: these never fill a card.
  accentDeep: '#6B5CF0',
  accentGlow: 'rgba(139, 124, 255, 0.34)',
  accentWarm: '#A79BFF',
  accentWarmMuted: 'rgba(167, 155, 255, 0.16)',

  // Metallic gold — luxury punch only. Rare highlight roles, never `accent`.
  gold: '#D4AF37',
  goldMuted: 'rgba(212, 175, 55, 0.16)',

  // Status (semantic — greens/ambers/reds, not brand)
  statusConnected: '#63D7A6',
  statusConnectedMuted: 'rgba(99, 215, 166, 0.16)',
  statusConnecting: '#D6B76A',
  statusConnectingMuted: 'rgba(214, 183, 106, 0.14)',
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

/**
 * 150–250 ms for everything the operator touches (visual-direction motion
 * lock); `breath` is the half-cycle of the few things that pulse on their
 * own — a connecting dot, the streaming caret.
 */
export const Motion = {
  duration: {
    fast: 150,
    normal: 200,
    slow: 250,
    breath: 900,
  },
  easing: {
    standard: Easing.bezier(0.2, 0, 0, 1),
    decelerate: Easing.bezier(0, 0, 0.2, 1),
    accelerate: Easing.bezier(0.4, 0, 1, 1),
    spring: Easing.elastic(0.7),
  },
} as const;

/**
 * `display` and `title` are set in Instrument Serif (400 is its only weight),
 * so their `fontWeight` stays 400 — a synthetic bold on a display serif reads
 * as a rendering fault. Everything the operator operates stays Instrument Sans.
 */
export const Typography = {
  display: { fontSize: 40, lineHeight: 44, fontWeight: '400' as const, letterSpacing: -0.4 },
  title: { fontSize: 32, lineHeight: 38, fontWeight: '400' as const, letterSpacing: -0.3 },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '600' as const, letterSpacing: -0.2 },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' as const, letterSpacing: 0 },
  callout: { fontSize: 15, lineHeight: 20, fontWeight: '500' as const, letterSpacing: -0.1 },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '500' as const, letterSpacing: 0 },
  eyebrow: { fontSize: 12, lineHeight: 16, fontWeight: '600' as const, letterSpacing: 0.2 },
  micro: { fontSize: 11, lineHeight: 14, fontWeight: '500' as const, letterSpacing: 0.4 },
  mono: { fontSize: 13, lineHeight: 20, fontWeight: '500' as const },
} as const;

export const FontFamily = {
  serif: 'InstrumentSerif_400Regular',
  serifItalic: 'InstrumentSerif_400Regular_Italic',
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
