import { Palette } from '@/constants/tokens';

import type { GlassVariant } from './types';

/**
 * Variant → surface treatment. Shared by all platforms; platform files may
 * layer native effects (blur/liquid glass) on top of the same mapping.
 *
 * Flat elevated stage panels (docs/visual-direction-2026-09.md): hero/surface/
 * inset resolve to the solid near-black elevation ramp, never the translucent
 * glass tiers. Chip keeps the violet accent pair. No gold here — gold is a rare
 * explicit highlight, not a surface default.
 *
 * S4b — **no edge by default**. The elevation steps are wide enough that a card
 * reads from the stage without ringing itself, so every variant carries
 * `borderWidth: 0`. The `borderColor` stays in the map because it is the value a
 * surface reaches for the moment it *does* need an edge, and because the
 * settings stacks and the sheet layer read this API.
 *
 * The rule for the whole app: the shared surface never rings by default; a
 * consumer that means it — a focused input, a selected row, a failure, a
 * floating sheet — says so with its own `borderWidth` in its own style.
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
  { backgroundColor: string; borderColor: string; borderWidth: number }
> = {
  hero: {
    backgroundColor: Palette.backgroundRaised,
    borderColor: Palette.borderStrong,
    borderWidth: 0,
  },
  surface: {
    backgroundColor: Palette.backgroundElevated,
    borderColor: Palette.border,
    borderWidth: 0,
  },
  inset: {
    backgroundColor: Palette.backgroundInset,
    borderColor: Palette.borderSubtle,
    borderWidth: 0,
  },
  chip: {
    backgroundColor: Palette.accentMuted,
    borderColor: Palette.accentWarmMuted,
    borderWidth: 0,
  },
};