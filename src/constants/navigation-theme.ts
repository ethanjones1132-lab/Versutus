import { DarkTheme } from 'expo-router';

import { Palette } from '@/constants/tokens';

export const VersutusDarkTheme = {
  ...DarkTheme,
  dark: true,
  colors: {
    ...DarkTheme.colors,
    primary: Palette.accentWarm,
    background: Palette.background,
    card: Palette.backgroundElevated,
    text: Palette.textPrimary,
    border: Palette.border,
    notification: Palette.accentWarm,
  },
} as const;
