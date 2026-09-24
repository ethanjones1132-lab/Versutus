import { Palette } from '@/constants/tokens';

import type { GlassVariant } from './types';

/**
 * Variant → surface treatment. Shared by all platforms; platform files may
 * layer native effects (blur/liquid glass) on top of the same mapping.
 *
 * Flat elevated stage panels + cool hairline borders first
 * (docs/visual-direction-2026-09.md): hero/surface/inset resolve to the
 * solid near-black elevation ramp, never the translucent glass tiers. Chip
 * keeps the violet accent pair. No gold here — gold is a rare explicit
 * highlight, not a surface default.
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
  hero: { backgroundColor: Palette.backgroundRaised, borderColor: Palette.borderStrong },
  surface: { backgroundColor: Palette.backgroundElevated, borderColor: Palette.border },
  inset: { backgroundColor: Palette.backgroundInset, borderColor: Palette.borderSubtle },
  chip: { backgroundColor: Palette.accentMuted, borderColor: Palette.accentWarmMuted },
};