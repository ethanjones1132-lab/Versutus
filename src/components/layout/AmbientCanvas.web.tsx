import type { AmbientCanvasProps } from './ambient-fallback';

/**
 * The web stage's one still lamp: the same violet light the native Skia
 * canvas draws above the top edge, as a CSS radial gradient so it fades to
 * nothing instead of ending in the hard rim a solid disc leaves.
 */
export function AmbientCanvas(_props: AmbientCanvasProps) {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        background:
          'radial-gradient(120% 55% at 50% -12%, rgba(139, 124, 255, 0.16) 0%, rgba(139, 124, 255, 0.05) 45%, transparent 72%)',
      }}
    />
  );
}
