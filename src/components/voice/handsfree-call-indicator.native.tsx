// ─── The ambient call indicator, in Skia ──────────────────────────────────
// A small pulsing dot whose dimensions derive from the level sample the
// provider holds in a Reanimated shared value: the circle reads it on the UI
// thread through `useDerivedValue`, so per-sample amplitude never runs React
// render work on the banner tree it sits in. When the platform supplies no
// `level`, the value stays 0 and this draws the same static shape.

import { Circle, Canvas } from '@shopify/react-native-skia';
import type { SharedValue } from 'react-native-reanimated';
import { useDerivedValue } from 'react-native-reanimated';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { HandsfreeCallIndicatorFallback } from './handsfree-call-indicator-fallback';

type HandsfreeCallIndicatorProps = {
  /** The live 0–1 amplitude sample, held by the provider as a shared value
   * so the Skia circle reads it on the UI thread. */
  level: SharedValue<number>;
  /** Whether any audio is expected right now. */
  active: boolean;
  /** The dot's color — a token, so this file invents no palette of its own. */
  color: string;
  size?: number;
};

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

export function HandsfreeCallIndicator({
  level,
  active,
  color,
  size = 28,
}: HandsfreeCallIndicatorProps) {
  // The fallback is a plain View, so it reads the sample's value at render
  // time: it draws only if the Skia mount fails, and a failed mount means the
  // banner can still redraw while the call lives.
  const fallback = (
    <HandsfreeCallIndicatorFallback
      level={level.value}
      active={active}
      color={color}
      size={size}
    />
  );
  return (
    <IndicatorBoundary fallback={fallback}>
      <SkiaIndicator level={level} active={active} color={color} size={size} />
    </IndicatorBoundary>
  );
}

function SkiaIndicator({
  level,
  active,
  color,
  size = 28,
}: HandsfreeCallIndicatorProps) {
  const clamped = useDerivedValue(() => Math.max(0, Math.min(1, level.value)));
  return (
    <View style={[styles.frame, { width: size, height: size }]}>
      <Canvas style={{ width: size, height: size }}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={useDerivedValue(
            () => (size / 2 - 2) * (active ? 0.55 + clamped.value * 0.45 : 0.55),
          )}
          color={color}
          opacity={useDerivedValue(() => (active ? 0.5 + clamped.value * 0.5 : 0.4))}
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
