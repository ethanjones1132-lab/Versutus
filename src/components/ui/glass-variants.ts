import { Palette } from '@/constants/tokens';

import type { GlassVariant } from './types';

/**
 * Variant → surface treatment. Shared by all platforms; platform files may
 * layer native effects (blur/liquid glass) on top of the same mapping.
 *
 * Lives in its own module WITHOUT a platform suffix so every platform variant
 * (GlassSurface.tsx / .ios.tsx / .web.tsx) can import it without hitting a
 * self-import cycle: a specifier like './GlassSurface' from inside
 * GlassSurface.web.tsx resolves to GlassSurface.web.tsx itself under
 * platform-aware resolution, leaving the binding undefined and crashing every
 * chip-variant surface at render time.
 */
export const glassVariantStyles: Record<
  GlassVariant,
  { backgroundColor: string; borderColor: string }
> = {
  hero: { backgroundColor: Palette.glassHero, borderColor: Palette.glassHeroBorder },
  surface: { backgroundColor: Palette.glass, borderColor: Palette.glassBorder },
  inset: { backgroundColor: Palette.backgroundInset, borderColor: Palette.borderSubtle },
  chip: { backgroundColor: Palette.accentMuted, borderColor: Palette.accentWarmMuted },
};