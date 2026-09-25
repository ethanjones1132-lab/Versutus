import { StyleSheet, View } from 'react-native';

import { useTokens } from '@/hooks/use-tokens';

export type AmbientCanvasProps = {
  parallaxX?: number;
  parallaxY?: number;
};

/**
 * Flat still-glow fallback (web + native Skia boundary). No film texture, plates,
 * drifting orbs, or stray rules — matches the quiet native stage (S4).
 */
export function AmbientFallback(_props: AmbientCanvasProps = {}) {
  const tokens = useTokens();

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View
        style={[
          styles.glow,
          { backgroundColor: tokens.accentMuted },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  glow: {
    position: 'absolute',
    top: '-18%',
    left: '-12%',
    width: 420,
    height: 420,
    borderRadius: 210,
    opacity: 0.55,
  },
});
