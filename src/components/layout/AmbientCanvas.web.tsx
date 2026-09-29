import { useEffect, useRef, useState } from 'react';

import { linearToSrgb, STAGE_BASE, type Rgb, type StageLights } from '@/lib/stage/lamp';
import { useStageLights } from '@/lib/stage/use-stage-lights';

import type { AmbientCanvasProps } from './ambient-fallback';
import { mountStage, type StageHandle } from './stage-gl';

function css(color: Rgb, strength: number): string {
  const channel = (i: number) => Math.round(linearToSrgb(STAGE_BASE[i] + color[i] * strength) * 255);
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

/**
 * The lamp as plain CSS, for a browser that cannot run the shader: the same
 * room colour and seat, still, with no air in it.
 */
function CssLamp({ lights }: { lights: StageLights }) {
  const { key } = lights;
  const x = `${Math.round(key.x * 100)}%`;
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        background: `radial-gradient(130% 62% at ${x} -14%, ${css(key.core, 0.82)} 0%, ${css(key.edge, 0.5)} 34%, ${css(key.edge, 0.12)} 62%, transparent 86%)`,
      }}
    />
  );
}

/**
 * The web stage: the lamp shader on a canvas behind every Screen. The GPU
 * work and the frame loop live in ./stage-gl (one context app-wide); this
 * component hands it the room, the scroll, and a canvas to light.
 */
export function AmbientCanvas({ parallaxY = 0, room }: AmbientCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const handleRef = useRef<StageHandle | null>(null);
  const [unlit, setUnlit] = useState(false);
  const lights = useStageLights(room);
  const initialLights = useRef(lights);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const handle = mountStage(canvas, initialLights.current, () => setUnlit(true));
    if (!handle) {
      setUnlit(true);
      return undefined;
    }
    handleRef.current = handle;
    return () => {
      handle.unmount();
      handleRef.current = null;
    };
  }, []);

  useEffect(() => {
    handleRef.current?.setRoom(lights);
  }, [lights]);

  useEffect(() => {
    handleRef.current?.setScroll(parallaxY);
  }, [parallaxY]);

  if (unlit) return <CssLamp lights={lights} />;
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        display: 'block',
        pointerEvents: 'none',
      }}
    />
  );
}
