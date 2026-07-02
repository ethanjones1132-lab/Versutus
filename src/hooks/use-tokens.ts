import { Platform } from 'react-native';

import { legacyColorMap, paletteForScheme, type SemanticPalette } from '@/constants/tokens';
import { useColorScheme } from '@/hooks/use-color-scheme';

export type Tokens = SemanticPalette & {
  scheme: 'light' | 'dark';
};

function resolveScheme(raw: ReturnType<typeof useColorScheme>): 'light' | 'dark' {
  // Brand-first: lock dark until a light luxury surface is intentionally designed and baselined.
  if (Platform.OS === 'android' || Platform.OS === 'ios' || Platform.OS === 'web') return 'dark';
  if (raw === 'unspecified' || raw == null) return 'dark';
  return raw;
}

export function useTokens(): Tokens {
  const scheme = resolveScheme(useColorScheme());
  const palette = paletteForScheme(scheme);

  return {
    scheme,
    ...palette,
  };
}

/** @deprecated Prefer useTokens — returns legacy-shaped colors for existing components */
export function useLegacyThemeColors() {
  const tokens = useTokens();
  return legacyColorMap(tokens);
}
