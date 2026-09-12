// ─── The ambient call indicator, in Skia ──────────────────────────────────
// A small pulsing dot driven by the native `level` amplitude stream. It is
// rewritten on each level sample rather than animated by a worklet, because
// the sample is already React state at ~10/s and a small banner shape does not
// warrant a UI-thread animation. When the platform supplies no `level`, the
// value stays 0 and this draws the same static shape.

import { Circle, Canvas } from '@shopify/react-native-skia';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  HandsfreeCallIndicatorFallback,
  type HandsfreeCallIndicatorProps,
} from './handsfree-call-indicator-fallback';

/**
 * A Skia mount can throw where there is no GPU surface; an indicator is never
 * worth taking the screen down for, so a failed mount draws the plain shape.
 */
class IndicatorBoundary extends Component<
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

export function HandsfreeCallIndicator(props: HandsfreeCallIndicatorProps) {
  return (
    <IndicatorBoundary fallback={<HandsfreeCallIndicatorFallback {...props} />}>
      <SkiaIndicator {...props} />
    </IndicatorBoundary>
  );
}

function SkiaIndicator({ level, active, color, size = 28 }: HandsfreeCallIndicatorProps) {
  const clamped = Math.max(0, Math.min(1, level));
  const radius = (size / 2 - 2) * (active ? 0.55 + clamped * 0.45 : 0.55);
  return (
    <View style={[styles.frame, { width: size, height: size }]}>
      <Canvas style={{ width: size, height: size }}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          color={color}
          opacity={active ? 0.5 + clamped * 0.5 : 0.4}
        />
      </Canvas>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
