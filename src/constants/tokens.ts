import { Platform } from 'react-native';
import { Easing } from 'react-native-reanimated';

export const Palette = {
  background: '#030304',
  backgroundElevated: '#0A0908',
  backgroundInset: '#070607',
  glass: 'rgba(14, 12, 10, 0.78)',
  glassBorder: 'rgba(229, 198, 126, 0.18)',
  glassHighlight: 'rgba(255, 236, 190, 0.075)',

  textPrimary: '#F7F1E3',
  textSecondary: '#B8AE9A',
  textTertiary: '#7F7668',
  textInverse: '#070503',

  accent: '#D6B76A',
  accentMuted: 'rgba(214, 183, 106, 0.18)',
  accentWarm: '#F0D690',
  accentWarmMuted: 'rgba(240, 214, 144, 0.16)',

  statusConnected: '#63D7A6',
  statusConnecting: '#D6B76A',
  statusDisconnected: '#E56D6D',
  statusPairing: '#F0D690',

  border: 'rgba(229, 198, 126, 0.12)',
  borderStrong: 'rgba(240, 214, 144, 0.28)',
} as const;

export const LightPalette = {
  background: '#F6F1E7',
  backgroundElevated: '#FFFCF4',
  backgroundInset: '#EFE6D4',
  glass: 'rgba(255, 252, 244, 0.84)',
  glassBorder: 'rgba(95, 68, 23, 0.14)',
  glassHighlight: 'rgba(255, 255, 255, 0.72)',

  textPrimary: '#17120A',
  textSecondary: '#5F5546',
  textTertiary: '#9C8E78',
  textInverse: '#070503',

  accent: '#9D7225',
  accentMuted: 'rgba(157, 114, 37, 0.13)',
  accentWarm: '#C7953B',
  accentWarmMuted: 'rgba(199, 149, 59, 0.16)',

  statusConnected: '#059669',
  statusConnecting: '#D97706',
  statusDisconnected: '#DC2626',
  statusPairing: '#A67C2E',

  border: 'rgba(0, 0, 0, 0.08)',
  borderStrong: 'rgba(0, 0, 0, 0.14)',
} as const;

export type SemanticPalette = {
  [K in keyof typeof Palette]: string;
};
export type SemanticColor = keyof SemanticPalette;

/** @deprecated Use SemanticColor — kept for ThemedText/ThemedView migration */
export type LegacyThemeColor = 'text' | 'background' | 'backgroundElement' | 'backgroundSelected' | 'textSecondary';

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
  sm: 8,
  md: 10,
  lg: 14,
  xl: 18,
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

export function paletteForScheme(scheme: 'light' | 'dark'): SemanticPalette {
  return scheme === 'light' ? LightPalette : Palette;
}

/** Maps legacy theme keys to semantic palette for gradual migration */
export function legacyColorMap(palette: SemanticPalette): Record<LegacyThemeColor, string> {
  return {
    text: palette.textPrimary,
    background: palette.background,
    backgroundElement: palette.backgroundElevated,
    backgroundSelected: palette.glassHighlight,
    textSecondary: palette.textSecondary,
  };
}
