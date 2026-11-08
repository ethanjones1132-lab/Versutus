/**
 * How big the native lamp shader's surface is. The air is slow, soft value
 * noise, so a smaller Skia surface scaled back up by the compositor looks the
 * same while the GPU shades a quarter of the pixels. Spec: docs/superpowers/specs/
 * 2026-11-07-ambient-redesign-design.md section 3.
 */

/** The fraction of the screen's resolution the lamp renders at by default. */
export const STAGE_RENDER_SCALE = 0.5;

/** The field is drawn this much larger than the stage on every side (dp), so parallax and tilt can move it by transform without showing an edge. */
export const STAGE_OVERSIZE_DP = 12;

export type Box = { width: number; height: number };

export function scaledCanvasSize(box: Box, scale: number): Box {
  const s = Number.isFinite(scale) && scale > 0 && scale <= 1 ? scale : 1;
  return {
    width: Math.max(1, Math.round(box.width * s)),
    height: Math.max(1, Math.round(box.height * s)),
  };
}

/** The scale that takes the (rounded) canvas back up to cover the box exactly. */
export function upscaleFactor(box: Box, canvas: Box): number {
  return Math.max(box.width / canvas.width, box.height / canvas.height);
}

export function oversizedBox(box: Box): Box {
  return { width: box.width + 2 * STAGE_OVERSIZE_DP, height: box.height + 2 * STAGE_OVERSIZE_DP };
}
