import { Palette, type SemanticPalette } from '@/constants/tokens';

export type Tokens = SemanticPalette & {
  scheme: 'dark';
};

/**
 * Dark-only (decision 2026-08-10): returns the single dark palette.
 * Kept as a hook so feature components share one consumption contract and a
 * future light surface can be reintroduced without touching call sites.
 */
export function useTokens(): Tokens {
  return { scheme: 'dark', ...Palette };
}
