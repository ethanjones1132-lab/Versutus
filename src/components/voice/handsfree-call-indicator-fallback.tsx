// ─── The ambient call indicator, in plain views ───────────────────────────
// The fallback the Skia indicator degrades to on web, and the shape the native
// one draws too. It is never load-bearing: no logic anywhere reads it, and a
// platform that supplies no `level` just draws it static.

import { StyleSheet, View } from 'react-native';

export type HandsfreeCallIndicatorProps = {
  /** 0–1 amplitude, or 0 when the platform supplies none. */
  level: number;
  /** Whether any audio is expected right now. */
  active: boolean;
  /** The dot's color — a token, so this file invents no palette of its own. */
  color: string;
  size?: number;
};

export function HandsfreeCallIndicatorFallback({
  level,
  active,
  color,
  size = 28,
}: HandsfreeCallIndicatorProps) {
  const clamped = Math.max(0, Math.min(1, level));
  const scale = active ? 0.55 + clamped * 0.45 : 0.55;
  return (
    <View style={[styles.frame, { width: size, height: size }]}>
      <View
        style={[
          styles.dot,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: color,
            opacity: active ? 0.45 + clamped * 0.55 : 0.4,
            transform: [{ scale }],
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
