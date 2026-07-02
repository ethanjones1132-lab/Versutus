/**
 * Design tokens live in tokens.ts. This module re-exports legacy shapes
 * for components still migrating off ThemedText/ThemedView.
 */

import '@/global.css';

import { Platform } from 'react-native';

import { Fonts as TokenFonts, legacyColorMap, paletteForScheme, Radius } from '@/constants/tokens';

export const Colors = {
  light: legacyColorMap(paletteForScheme('light')),
  dark: legacyColorMap(paletteForScheme('dark')),
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = TokenFonts;

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export { Radius };

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;