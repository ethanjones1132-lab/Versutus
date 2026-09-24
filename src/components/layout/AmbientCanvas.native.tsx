import { Component, type ErrorInfo, type ReactNode, useEffect } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import {
  Canvas,
  Fill,
  Group,
  ImageShader,
  RadialGradient,
  Rect,
  useImage,
  vec,
} from '@shopify/react-native-skia';
import {
  cancelAnimation,
  Easing,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { useTokens } from '@/hooks/use-tokens';

import { AmbientFallback, type AmbientCanvasProps } from './ambient-fallback';

const VIOLET = 'rgba(139, 124, 255, 0.12)';
const VIOLET_BRIGHT = 'rgba(167, 155, 255, 0.12)';
const DRIFT = Easing.inOut(Easing.sin);

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

export function AmbientCanvas({ parallaxX = 0, parallaxY = 0 }: AmbientCanvasProps) {
  const tokens = useTokens();
  const { width, height } = useWindowDimensions();
  const grain = useImage(require('../../../assets/images/grain.png'));
  const driftA = useSharedValue(0);
  const driftB = useSharedValue(0);
  const parallaxXSv = useSharedValue(parallaxX);
  const parallaxYSv = useSharedValue(parallaxY);

  useEffect(() => {
    parallaxXSv.value = parallaxX;
    parallaxYSv.value = parallaxY;
  }, [parallaxX, parallaxXSv, parallaxY, parallaxYSv]);

  useEffect(() => {
    driftA.value = withRepeat(withTiming(1, { duration: 52_000, easing: DRIFT }), -1, true);
    driftB.value = withRepeat(withTiming(1, { duration: 68_000, easing: DRIFT }), -1, true);
    return () => {
      cancelAnimation(driftA);
      cancelAnimation(driftB);
    };
  }, [driftA, driftB]);

  const violetTransform = useDerivedValue(() => [
    { translateX: -0.15 * width + driftA.value * 40 + parallaxXSv.value * 8 },
    { translateY: -0.22 * height + driftA.value * 60 + parallaxYSv.value * 8 },
  ]);
  const violetBrightTransform = useDerivedValue(() => [
    { translateX: 0.58 * width + driftB.value * -48 + parallaxXSv.value * 8 },
    { translateY: 0.62 * height + driftB.value * -34 + parallaxYSv.value * 8 },
  ]);

  const fallback = <AmbientFallback parallaxX={parallaxX} parallaxY={parallaxY} />;

  return (
    <SkiaAmbientBoundary fallback={fallback}>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Canvas style={StyleSheet.absoluteFill}>
          <Group transform={violetTransform}>
            <Rect x={0} y={0} width={420} height={420}>
              <RadialGradient c={vec(210, 210)} r={210} colors={[VIOLET, 'transparent']} />
            </Rect>
          </Group>
          <Group transform={violetBrightTransform}>
            <Rect x={0} y={0} width={300} height={300}>
              <RadialGradient c={vec(150, 150)} r={150} colors={[VIOLET_BRIGHT, 'transparent']} />
            </Rect>
          </Group>
          {grain ? (
            <Fill opacity={0.16}>
              <ImageShader image={grain} tx="repeat" ty="repeat" fit="none" width={256} height={256} />
            </Fill>
          ) : null}
        </Canvas>
        <View
          style={[
            styles.plate,
            styles.plateTop,
            { backgroundColor: tokens.backgroundElevated, borderColor: tokens.border },
          ]}
        />
        <View
          style={[
            styles.plate,
            styles.plateBottom,
            { backgroundColor: tokens.backgroundInset, borderColor: tokens.border },
          ]}
        />
        <View style={[styles.rule, styles.ruleTop, { backgroundColor: tokens.accentMuted }]} />
        <View style={[styles.rule, styles.ruleSide, { backgroundColor: tokens.accentWarmMuted }]} />
        <View style={[styles.vignette, styles.vignetteTop, { backgroundColor: tokens.background }]} />
        <View style={[styles.vignette, styles.vignetteBottom, { backgroundColor: tokens.background }]} />
        <View style={[styles.centerLine, { backgroundColor: tokens.border }]} />
      </View>
    </SkiaAmbientBoundary>
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
  rule: {
    position: 'absolute',
    opacity: 0.9,
  },
  ruleTop: {
    top: 126,
    left: '9%',
    right: '18%',
    height: StyleSheet.hairlineWidth,
  },
  ruleSide: {
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
