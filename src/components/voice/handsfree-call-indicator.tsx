// The web/plain build of the ambient call indicator: Metro resolves the
// `.native.tsx` sibling on device and this plain shape everywhere else. The
// sample arrives as the same shared value both sides are given, so the shape
// is drawn from its current value whenever the banner renders — there is no
// UI thread animating the plain View, so the per-sample writes are simply
// held rather than drawn.

import type { SharedValue } from 'react-native-reanimated';

import { HandsfreeCallIndicatorFallback } from './handsfree-call-indicator-fallback';

export function HandsfreeCallIndicator({
  level,
  active,
  color,
  size = 28,
}: {
  level: SharedValue<number>;
  active: boolean;
  color: string;
  size?: number;
}) {
  return (
    <HandsfreeCallIndicatorFallback
      level={level.value}
      active={active}
      color={color}
      size={size}
    />
  );
}
