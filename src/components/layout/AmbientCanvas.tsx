import { useEffect } from 'react';
import { Image, StyleSheet, View, type DimensionValue } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { useTokens } from '@/hooks/use-tokens';

/**
 * Architectural black field with metallic sightlines, a slow gold aurora, and
 * a faint film-grain overlay. The sightlines stay static (brand deco); only
 * the glow drifts, so the field reads alive without turning into decoration.
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

      <GlowOrb
        size={420}
        color={tokens.accentWarmMuted}
        startX="-15%"
        startY="-22%"
        duration={52_000}
        drift={{ x: 40, y: 60 }}
      />
      <GlowOrb
        size={300}
        color={tokens.accentMuted}
        startX="58%"
        startY="62%"
        duration={68_000}
        drift={{ x: -48, y: -34 }}
      />

      <Image
        source={require('../../../assets/images/grain.png')}
        resizeMode="repeat"
        style={styles.grain}
      />
    </View>
  );
}

const DRIFT_EASING = Easing.inOut(Easing.sin);

function GlowOrb({
  size,
  color,
  startX,
  startY,
  duration,
  drift,
}: {
  size: number;
  color: string;
  startX: DimensionValue;
  startY: DimensionValue;
  duration: number;
  drift: { x: number; y: number };
}) {
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const scale = useSharedValue(1);

  useEffect(() => {
    tx.value = withRepeat(withTiming(drift.x, { duration, easing: DRIFT_EASING }), -1, true);
    ty.value = withRepeat(withTiming(drift.y, { duration, easing: DRIFT_EASING }), -1, true);
    scale.value = withRepeat(
      withTiming(1.18, { duration: duration * 1.4, easing: DRIFT_EASING }),
      -1,
      true,
    );
    return () => {
      cancelAnimation(tx);
      cancelAnimation(ty);
      cancelAnimation(scale);
    };
  }, [drift.x, drift.y, duration, scale, tx, ty]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      { scale: scale.value },
    ],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.orb,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: color, left: startX, top: startY },
        animatedStyle,
      ]}
    />
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
  orb: {
    position: 'absolute',
    opacity: 0.12,
  },
  grain: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    opacity: 0.16,
  },
});