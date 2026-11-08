import { Canvas, Circle, RadialGradient, vec } from '@shopify/react-native-skia';
import { StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import { LAYER_TIMING, swellOpacity, swellRise, swellScale } from '@/lib/stage/layers';

/**
 * The one small Skia canvas the stage owns above the Veil (spec: at most one
 * per screen). It holds a soft gradient circle that is drawn once and then
 * moved, scaled and faded by transform and opacity alone, so a sent message's
 * swell costs no shader work. Ripples and call rings join it in a later phase.
 *
 * The canvas is small and scaled up: a soft gradient survives upscaling.
 */
const GLINT_DP = 140;
/** 140 dp scaled by 3 is the 420 dp circle the motion draft describes. */
const SWELL_BASE_SCALE = 3;
/** How far up the stage the swell travels, as a fraction of its height. */
const SWELL_TRAVEL = 0.45;

type Props = {
  /** 0 to 1 over `LAYER_TIMING.swellMs`; 1 means nothing is rising. */
  swell: SharedValue<number>;
  stageHeight: SharedValue<number>;
  /** The room's light as a visible colour, and the same colour fully transparent. */
  core: string;
  clear: string;
};

export function StageGlint({ swell, stageHeight, core, clear }: Props) {
  const style = useAnimatedStyle(() => {
    const p = swell.get();
    const elapsed = p < 1 ? p * LAYER_TIMING.swellMs : null;
    const rise = swellRise(elapsed);
    return {
      opacity: swellOpacity(elapsed),
      transform: [
        { translateY: -stageHeight.get() * SWELL_TRAVEL * rise },
        { scale: SWELL_BASE_SCALE * swellScale(rise) },
      ],
    };
  });
  return (
    <Animated.View pointerEvents="none" style={[styles.glint, style]}>
      <Canvas style={StyleSheet.absoluteFill}>
        <Circle cx={GLINT_DP / 2} cy={GLINT_DP / 2} r={GLINT_DP / 2}>
          <RadialGradient c={vec(GLINT_DP / 2, GLINT_DP / 2)} r={GLINT_DP / 2} colors={[core, clear]} />
        </Circle>
      </Canvas>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  glint: {
    position: 'absolute',
    left: '50%',
    bottom: 24,
    width: GLINT_DP,
    height: GLINT_DP,
    marginLeft: -GLINT_DP / 2,
    opacity: 0,
  },
});
