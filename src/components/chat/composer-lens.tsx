import { useEffect, useId, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  Easing,
  Keyframe,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';

import { Icon } from '@/components/ui';
import { useTokens } from '@/hooks/use-tokens';
import type { BotCrestTone } from '@/lib/bot-avatar';
import { ORB_BODY_STOPS, hexAlpha, mixHex, orbGlyphIsDark } from '@/lib/stage/composer-light';

/**
 * The Lens — the composer as a piece of glass in the lamp's light.
 *
 * Everything here is light, drawn over and around the pill's body:
 *  - the rim, which at rest catches the lamp on its upper-left lip (the same
 *    light that sheens every crest), and on focus kindles in the room's own
 *    colours — the colours of whoever you are writing to;
 *  - a soft halo of that colour behind the glass while it holds the cursor;
 *  - a glint that sweeps once across the glass when it takes focus and when
 *    a message leaves;
 *  - a shimmer through the rim on each burst of typing, so the glass answers
 *    the hand;
 *  - a slow breath of the rim while a hold-to-talk is listening — the one
 *    signal dictation has ever had.
 * Under Reduce Motion the rim still kindles and the halo still shows; the
 * glint, the shimmer and the breath do not move.
 */
export function ComposerBezel({
  tone,
  focused,
  listening,
  keystrokes,
  sweeps,
  children,
  style,
}: {
  tone: BotCrestTone;
  focused: boolean;
  listening: boolean;
  /** Bumped as the draft grows: each change sends a shimmer through the rim. */
  keystrokes: number;
  /** Bumped when the glass takes focus or a message leaves: one glint sweeps. */
  sweeps: number;
  children: React.ReactNode;
  style?: React.ComponentProps<typeof View>['style'];
}) {
  const reduced = useReducedMotion();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');

  const lit = useSharedValue(0);
  const glassWidth = useSharedValue(0);
  const shimmer = useSharedValue(0);
  const breath = useSharedValue(0);
  const sweep = useSharedValue(0);

  const kindled = focused || listening;
  useEffect(() => {
    lit.set(withTiming(kindled ? 1 : 0, { duration: 260, easing: Easing.out(Easing.cubic) }));
  }, [kindled, lit]);

  useEffect(() => {
    if (keystrokes === 0 || reduced) return;
    shimmer.set(
      withSequence(
        withTiming(1, { duration: 70, easing: Easing.out(Easing.quad) }),
        withTiming(0, { duration: 560, easing: Easing.out(Easing.cubic) }),
      ),
    );
  }, [keystrokes, reduced, shimmer]);

  useEffect(() => {
    if (listening && !reduced) {
      breath.set(withRepeat(withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.sin) }), -1, true));
    } else {
      breath.set(withTiming(0, { duration: 300 }));
    }
  }, [listening, reduced, breath]);

  useEffect(() => {
    if (sweeps === 0 || reduced) return;
    sweep.set(0);
    sweep.set(withTiming(1, { duration: 1050, easing: Easing.inOut(Easing.cubic) }));
  }, [sweeps, reduced, sweep]);

  const restRim = useAnimatedStyle(() => ({ opacity: 1 - lit.get() }));
  const litRim = useAnimatedStyle(() => ({
    opacity: Math.min(1, lit.get() * (0.78 + 0.22 * breath.get()) + shimmer.get() * 0.45),
  }));
  const halo = useAnimatedStyle(() => ({
    opacity: Math.min(1, lit.get() * (0.5 + 0.5 * breath.get()) + shimmer.get() * 0.3),
  }));
  const glint = useAnimatedStyle(() => {
    const p = sweep.get();
    const width = glassWidth.get();
    return {
      opacity: p <= 0 || p >= 1 ? 0 : Math.sin(Math.PI * p),
      transform: [{ translateX: -0.45 * width + p * 1.9 * width }, { skewX: '-18deg' }],
    };
  });

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width !== size.width || height !== size.height) setSize({ width, height });
    glassWidth.set(width);
  };

  const { width, height } = size;
  const radius = height / 2;
  const glintWidth = Math.max(60, width * 0.28);

  return (
    <View style={[styles.wrap, style]} onLayout={onLayout}>
      {/* The halo: the room's light gathered behind the glass. */}
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          styles.halo,
          { borderRadius: radius, boxShadow: `0 0 26px 3px ${hexAlpha(tone.to, 0.55)}, 0 0 60px 6px ${hexAlpha(tone.from, 0.16)}` },
          halo,
        ]}
      />

      {children}

      {width > 0 ? (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          {/* The glint: one sweep of light across the glass. */}
          <View style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden' }]}>
            <Animated.View style={[styles.glint, { width: glintWidth, height }, glint]}>
              <Svg width={glintWidth} height={height}>
                <Defs>
                  <LinearGradient id={`glint-${id}`} x1="0" y1="0" x2="1" y2="0">
                    <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0} />
                    <Stop offset="0.5" stopColor="#FFFFFF" stopOpacity={0.2} />
                    <Stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
                  </LinearGradient>
                </Defs>
                <Rect width={glintWidth} height={height} fill={`url(#glint-${id})`} />
              </Svg>
            </Animated.View>
          </View>

          {/* The rim at rest: the lamp catching the upper-left lip. */}
          <Animated.View style={[StyleSheet.absoluteFill, restRim]}>
            <Svg width={width} height={height}>
              <Defs>
                <LinearGradient id={`rest-${id}`} gradientUnits="userSpaceOnUse" x1={0} y1={0} x2={width * 0.7} y2={height}>
                  <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.28} />
                  <Stop offset="0.4" stopColor="#FFFFFF" stopOpacity={0.08} />
                  <Stop offset="1" stopColor="#FFFFFF" stopOpacity={0.03} />
                </LinearGradient>
              </Defs>
              <Rect
                x={0.5}
                y={0.5}
                width={width - 1}
                height={height - 1}
                rx={radius - 0.5}
                fill="none"
                stroke={`url(#rest-${id})`}
                strokeWidth={1}
              />
            </Svg>
          </Animated.View>

          {/* The rim kindled: the room's two colours, brightest at the lip. */}
          <Animated.View style={[StyleSheet.absoluteFill, litRim]}>
            <Svg width={width} height={height}>
              <Defs>
                <LinearGradient id={`lit-${id}`} gradientUnits="userSpaceOnUse" x1={0} y1={0} x2={width} y2={height}>
                  <Stop offset="0" stopColor={tone.from} stopOpacity={1} />
                  <Stop offset="0.5" stopColor={tone.to} stopOpacity={0.8} />
                  <Stop offset="1" stopColor={tone.to} stopOpacity={0.4} />
                </LinearGradient>
              </Defs>
              <Rect
                x={0.75}
                y={0.75}
                width={width - 1.5}
                height={height - 1.5}
                rx={radius - 0.75}
                fill="none"
                stroke={`url(#lit-${id})`}
                strokeWidth={1.5}
              />
            </Svg>
          </Animated.View>
        </View>
      ) : null}
    </View>
  );
}

const orbBloom = new Keyframe({
  0: { opacity: 0, transform: [{ scale: 0.62 }] },
  100: { opacity: 1, transform: [{ scale: 1 }], easing: Easing.out(Easing.cubic) },
}).duration(220);

/**
 * The send orb — a jewel cut from the room's crest: its two stops as the body,
 * a sheen pooled at the upper left, and a rim lit on top and shadowed beneath
 * (the crest's own material). It blooms in when there is something to send,
 * and on send it lets go a ring of light as the message leaves.
 */
export function SendOrb({
  tone,
  disabled,
}: {
  tone: BotCrestTone;
  disabled: boolean;
}) {
  const tokens = useTokens();
  const reduced = useReducedMotion();
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');

  const dark = orbGlyphIsDark(tone);
  const size = ORB;
  const r = size / 2;

  return (
    <Animated.View entering={reduced ? undefined : orbBloom} style={styles.orbSlot}>
      <View
        style={[
          styles.orb,
          { boxShadow: `0 6px 18px ${hexAlpha(tone.to, disabled ? 0.18 : 0.5)}` },
          disabled ? styles.orbDisabled : null,
        ]}>
        <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
          <Defs>
            <LinearGradient id={`body-${id}`} x1="0.2" y1="0" x2="0.8" y2="1">
              {ORB_BODY_STOPS.map((stop) => (
                <Stop key={stop.offset} offset={stop.offset} stopColor={mixHex(tone.from, tone.to, stop.toward)} />
              ))}
            </LinearGradient>
            <RadialGradient id={`sheen-${id}`} cx="0.34" cy="0.22" rx="0.6" ry="0.48" fx="0.34" fy="0.22">
              <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.5} />
              <Stop offset="0.6" stopColor="#FFFFFF" stopOpacity={0.06} />
              <Stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
            </RadialGradient>
            <LinearGradient id={`rim-${id}`} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.55} />
              <Stop offset="0.5" stopColor="#FFFFFF" stopOpacity={0.08} />
              <Stop offset="1" stopColor="#000000" stopOpacity={0.3} />
            </LinearGradient>
          </Defs>
          <Circle cx={r} cy={r} r={r} fill={`url(#body-${id})`} />
          <Circle cx={r} cy={r} r={r} fill={`url(#sheen-${id})`} />
          <Circle cx={r} cy={r} r={r - 0.6} fill="none" stroke={`url(#rim-${id})`} strokeWidth={1.2} />
        </Svg>
        <Icon
          name={{ ios: 'arrow.up', android: 'arrow_upward', web: 'arrow_upward' }}
          size={18}
          weight="semibold"
          color={dark ? tokens.textInverse : tokens.textPrimary}
        />
      </View>
    </Animated.View>
  );
}

/**
 * The ring a message lets go as it leaves: it widens from the orb's rim and
 * fades. It lives in the send slot, not in the orb — a send starts the reply
 * at once, and the orb gives its place to Stop while the ring is still going.
 */
export function LaunchRing({ tone, launches }: { tone: BotCrestTone; launches: number }) {
  const reduced = useReducedMotion();
  const ring = useSharedValue(0);

  useEffect(() => {
    if (launches === 0 || reduced) return;
    ring.set(0);
    ring.set(withTiming(1, { duration: 760, easing: Easing.out(Easing.cubic) }));
  }, [launches, reduced, ring]);

  const ringStyle = useAnimatedStyle(() => {
    const p = ring.get();
    return {
      opacity: p <= 0 || p >= 1 ? 0 : 0.8 * (1 - p),
      transform: [{ scale: 1 + 1.6 * p }],
    };
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.ring, { borderColor: tone.from, boxShadow: `0 0 12px ${hexAlpha(tone.from, 0.6)}` }, ringStyle]}
    />
  );
}

const ORB = 40;

const styles = StyleSheet.create({
  wrap: {
    position: 'relative',
  },
  halo: {
    backgroundColor: 'transparent',
  },
  glint: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  orbSlot: {
    width: ORB,
    height: ORB,
    alignItems: 'center',
    justifyContent: 'center',
  },
  orb: {
    width: ORB,
    height: ORB,
    borderRadius: ORB / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  orbDisabled: {
    opacity: 0.4,
  },
  ring: {
    position: 'absolute',
    width: ORB,
    height: ORB,
    borderRadius: ORB / 2,
    borderWidth: 1.5,
  },
});
