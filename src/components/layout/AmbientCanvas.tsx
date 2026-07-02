import { StyleSheet, View } from 'react-native';

import { useTokens } from '@/hooks/use-tokens';

/**
 * Architectural black field with metallic sightlines.
 * This keeps the app atmospheric without decorative blobs.
 */
export function AmbientCanvas() {
  const tokens = useTokens();

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View
        style={[
          styles.plate,
          styles.plateTop,
          {
            backgroundColor: tokens.backgroundElevated,
            borderColor: tokens.glassBorder,
          },
        ]}
      />
      <View
        style={[
          styles.plate,
          styles.plateBottom,
          {
            backgroundColor: tokens.backgroundInset,
            borderColor: tokens.border,
          },
        ]}
      />
      <View style={[styles.goldRule, styles.goldRuleTop, { backgroundColor: tokens.accentMuted }]} />
      <View style={[styles.goldRule, styles.goldRuleSide, { backgroundColor: tokens.accentWarmMuted }]} />
      <View style={[styles.vignette, styles.vignetteTop, { backgroundColor: tokens.background }]} />
      <View style={[styles.vignette, styles.vignetteBottom, { backgroundColor: tokens.background }]} />
      <View style={[styles.centerLine, { backgroundColor: tokens.glassBorder }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  plate: {
    position: 'absolute',
    borderWidth: StyleSheet.hairlineWidth,
  },
  plateTop: {
    top: -80,
    left: -36,
    right: 28,
    height: 230,
    opacity: 0.76,
    transform: [{ rotate: '-4deg' }],
  },
  plateBottom: {
    right: -64,
    bottom: -120,
    width: '78%',
    height: 310,
    opacity: 0.62,
    transform: [{ rotate: '7deg' }],
  },
  goldRule: {
    position: 'absolute',
    opacity: 0.9,
  },
  goldRuleTop: {
    top: 126,
    left: '9%',
    right: '18%',
    height: StyleSheet.hairlineWidth,
  },
  goldRuleSide: {
    top: '18%',
    right: 28,
    width: StyleSheet.hairlineWidth,
    height: '42%',
  },
  vignette: {
    position: 'absolute',
    left: 0,
    right: 0,
    opacity: 0.46,
  },
  vignetteTop: {
    top: 0,
    height: 150,
  },
  vignetteBottom: {
    bottom: 0,
    height: 190,
  },
  centerLine: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: '12%',
    width: StyleSheet.hairlineWidth,
    opacity: 0.28,
  },
});
