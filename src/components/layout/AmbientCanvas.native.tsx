import { Component, type ErrorInfo, type ReactNode } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { Canvas, Group, RadialGradient, Rect, vec } from '@shopify/react-native-skia';

import { AmbientFallback, type AmbientCanvasProps } from './ambient-fallback';

/** Single still violet wash — subliminal, no drift (S4 quiet stage). */
const GLOW = 'rgba(139, 124, 255, 0.10)';

class SkiaAmbientBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    this.setState({ failed: true });
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Quiet ambient field for every Screen: flat stage, at most one faint still
 * glow. Drift loops, film texture, tilted panels, and stray rules stay out —
 * those read as busy art against the structure-over-paint charter.
 */
export function AmbientCanvas(_props: AmbientCanvasProps) {
  const { width, height } = useWindowDimensions();
  const fallback = <AmbientFallback />;
  // Anchor the still glow upper-left; size scales with the shorter viewport edge.
  const side = Math.min(width, height) * 0.9;
  const originX = width * -0.12;
  const originY = height * -0.18;

  return (
    <SkiaAmbientBoundary fallback={fallback}>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Canvas style={StyleSheet.absoluteFill}>
          <Group transform={[{ translateX: originX }, { translateY: originY }]}>
            <Rect x={0} y={0} width={side} height={side}>
              <RadialGradient c={vec(side / 2, side / 2)} r={side / 2} colors={[GLOW, 'transparent']} />
            </Rect>
          </Group>
        </Canvas>
      </View>
    </SkiaAmbientBoundary>
  );
}
