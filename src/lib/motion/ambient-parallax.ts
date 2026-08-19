import { useCallback, useRef, useState } from 'react';

export type AmbientParallax = {
  parallaxX: number;
  parallaxY: number;
};

export function mapAmbientParallax(scrollYPx: number): AmbientParallax {
  if (!Number.isFinite(scrollYPx)) return { parallaxX: 0, parallaxY: 0 };
  const y = Math.max(-1, Math.min(1, scrollYPx / 480));
  return { parallaxX: 0, parallaxY: y };
}

/** Scroll handler that only re-renders when the mapped Y moves by ≥ 0.04. */
export function useAmbientParallaxScroll(): AmbientParallax & {
  onScroll: (event: { nativeEvent: { contentOffset: { y: number } } }) => void;
} {
  const [parallax, setParallax] = useState<AmbientParallax>({ parallaxX: 0, parallaxY: 0 });
  const lastY = useRef(0);
  const onScroll = useCallback((event: { nativeEvent: { contentOffset: { y: number } } }) => {
    const next = mapAmbientParallax(event.nativeEvent.contentOffset.y);
    if (Math.abs(next.parallaxY - lastY.current) < 0.04) return;
    lastY.current = next.parallaxY;
    setParallax(next);
  }, []);
  return { ...parallax, onScroll };
}
