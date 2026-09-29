import { Canvas, Fill, Shader, Skia, type SkRuntimeEffect } from '@shopify/react-native-skia';
import { useIsFocused } from 'expo-router';
import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { PixelRatio, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import {
  Easing,
  SensorType,
  useAnimatedReaction,
  useAnimatedSensor,
  useDerivedValue,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import {
  STAGE_GAIN,
  STAGE_TIMING,
  STILL_TIME_SEC,
  connectionGain,
  lampOnGain,
  stageUniforms,
  tintBlend,
  tintDipGain,
} from '@/lib/stage/choreography';
import { mixLights, type StageLights } from '@/lib/stage/lamp';
import { STAGE_SHADER_SKSL } from '@/lib/stage/shader';
import { getStageSignals, subscribeStageSignals } from '@/lib/stage/signals';
import { useStageLights } from '@/lib/stage/use-stage-lights';

import { AmbientFallback, type AmbientCanvasProps } from './ambient-fallback';

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

/** Compiled once per app run and shared by every stage. */
let stageEffect: SkRuntimeEffect | null | undefined;
function lampEffect(): SkRuntimeEffect | null {
  if (stageEffect === undefined) stageEffect = Skia.RuntimeEffect.Make(STAGE_SHADER_SKSL);
  return stageEffect;
}

/** The first stage of the session warms up from a dark room; later ones open lit. */
let firstLightDone = false;

type Tilt = { x: number; y: number };

/**
 * The phone's tilt as light: gravity, measured against a slowly following
 * rest pose, so the lamp shifts when the operator tips the phone and drifts
 * home when they hold it still — like a reflection that follows your hand.
 * Mounted only while the stage is on screen and motion is allowed, so the
 * sensor is off everywhere else.
 */
function TiltSource({ tiltX, tiltY }: { tiltX: SharedValue<number>; tiltY: SharedValue<number> }) {
  const gravity = useAnimatedSensor(SensorType.GRAVITY, { interval: 33 });
  const rest = useSharedValue<Tilt | null>(null);
  useAnimatedReaction(
    () => gravity.sensor.get(),
    (g) => {
      const length = Math.hypot(g.x, g.y, g.z);
      if (length < 1e-3) return;
      const x = g.x / length;
      const y = g.y / length;
      const base = rest.get() ?? { x, y };
      const next = { x: base.x + (x - base.x) * 0.015, y: base.y + (y - base.y) * 0.015 };
      rest.set(next);
      const dx = Math.max(-1, Math.min(1, (x - next.x) * 3));
      const dy = Math.max(-1, Math.min(1, (y - next.y) * 3));
      tiltX.set(tiltX.get() + (dx - tiltX.get()) * 0.2);
      tiltY.set(tiltY.get() + (dy - tiltY.get()) * 0.2);
    },
  );
  useEffect(
    () => () => {
      tiltX.set(withTiming(0, { duration: 600 }));
      tiltY.set(withTiming(0, { duration: 600 }));
    },
    [tiltX, tiltY],
  );
  return null;
}

/**
 * The native stage: the lamp shader (src/lib/stage/shader.ts) as a Skia
 * runtime effect, driven on the UI thread by Reanimated. The same curves as
 * the web renderer (src/lib/stage/choreography.ts), on shared values.
 *
 * It only moves while it is seen: the air's clock runs while the screen is
 * focused, motion is allowed and the operator has touched the app recently;
 * otherwise nothing changes and Skia draws nothing new.
 */
function LampCanvas({ effect, lights, parallaxY }: { effect: SkRuntimeEffect; lights: StageLights; parallaxY: number }) {
  const focused = useIsFocused();
  const reduced = useReducedMotion();
  const pixelRatio = PixelRatio.get();

  const size = useSharedValue({ width: 1, height: 1 });
  const time = useSharedValue(STILL_TIME_SEC);
  const pending = useSharedValue(0);
  const from = useSharedValue<StageLights>(lights);
  const to = useSharedValue<StageLights>(lights);
  const blend = useSharedValue(1);
  const tintMs = useSharedValue<number>(STAGE_TIMING.tintMs);
  const lampOn = useSharedValue(1);
  const speaking = useSharedValue(1);
  const connection = useSharedValue(connectionGain(getStageSignals().connection));
  const swell = useSharedValue(1);
  const scroll = useSharedValue(0);
  const tiltX = useSharedValue(0);
  const tiltY = useSharedValue(0);
  const [awake, setAwake] = useState(true);

  // The first light of the session.
  useEffect(() => {
    if (firstLightDone) return;
    firstLightDone = true;
    if (reduced) return;
    lampOn.set(0);
    lampOn.set(withTiming(1, { duration: STAGE_TIMING.lampOnMs, easing: Easing.linear }));
  }, [lampOn, reduced]);

  // A room change crossfades from wherever the light is right now.
  const mirror = useRef({ from: lights, to: lights, start: Number.NEGATIVE_INFINITY, ms: STAGE_TIMING.tintMs as number });
  useEffect(() => {
    const m = mirror.current;
    if (m.to === lights) return;
    const now = Date.now();
    const current = mixLights(m.from, m.to, tintBlend(now - m.start, m.ms));
    const ms = reduced ? STAGE_TIMING.reducedTintMs : STAGE_TIMING.tintMs;
    mirror.current = { from: current, to: lights, start: now, ms };
    from.set(current);
    to.set(lights);
    tintMs.set(ms);
    blend.set(0);
    blend.set(withTiming(1, { duration: ms, easing: Easing.linear }));
  }, [lights, reduced, from, to, tintMs, blend]);

  useEffect(() => {
    scroll.set(withTiming(Math.max(-1, Math.min(1, parallaxY)), { duration: STAGE_TIMING.scrollTau * 2 }));
  }, [parallaxY, scroll]);

  // What the room reacts to: sends, a Bot speaking, the Gate, a touch.
  useEffect(() => {
    let sendCount = getStageSignals().sendCount;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const rearm = () => {
      setAwake(true);
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => setAwake(false), STAGE_TIMING.idleAfterMs);
    };
    const apply = () => {
      const signals = getStageSignals();
      if (signals.sendCount !== sendCount) {
        sendCount = signals.sendCount;
        if (!reduced && focused) {
          swell.set(0);
          swell.set(withTiming(1, { duration: STAGE_TIMING.swellMs, easing: Easing.linear }));
        }
      }
      const target = signals.speaking ? STAGE_GAIN.speaking : 1;
      speaking.set(
        withTiming(target, {
          duration: (signals.speaking ? STAGE_TIMING.speakRiseTau : STAGE_TIMING.speakFallTau) * 2.2,
          easing: Easing.out(Easing.cubic),
        }),
      );
      connection.set(
        withTiming(connectionGain(signals.connection), {
          duration: STAGE_TIMING.connectionTau * 2.2,
          easing: Easing.out(Easing.cubic),
        }),
      );
      rearm();
    };
    rearm();
    const unsubscribe = subscribeStageSignals(apply);
    return () => {
      unsubscribe();
      if (idleTimer) clearTimeout(idleTimer);
    };
  }, [focused, reduced, swell, speaking, connection]);

  // The air's clock: advanced on the UI thread, but only handed to the shader
  // at the drift rate — it moves too slowly for more frames to show.
  const running = focused && !reduced && awake;
  const clock = useFrameCallback((info) => {
    'worklet';
    pending.set(pending.get() + (info.timeSincePreviousFrame ?? 0));
    if (pending.get() >= STAGE_TIMING.driftFrameMs) {
      time.set(time.get() + Math.min(pending.get(), 100) / 1000);
      pending.set(0);
    }
  }, false);
  useEffect(() => {
    clock.setActive(running);
  }, [clock, running]);

  const uniforms = useDerivedValue(() => {
    const t = tintBlend(blend.get() * tintMs.get(), tintMs.get());
    const swellElapsed = swell.get() < 1 ? swell.get() * STAGE_TIMING.swellMs : null;
    return stageUniforms({
      width: size.get().width,
      height: size.get().height,
      pixelRatio,
      timeSec: time.get(),
      lights: mixLights(from.get(), to.get(), t),
      gain:
        lampOnGain(lampOn.get() < 1 ? lampOn.get() * STAGE_TIMING.lampOnMs : null) *
        connection.get() *
        speaking.get() *
        tintDipGain(t),
      swellElapsedMs: swellElapsed,
      scroll: scroll.get(),
      tiltX: tiltX.get(),
      tiltY: tiltY.get(),
    });
  });

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    size.set({ width: Math.max(1, width), height: Math.max(1, height) });
  };

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} onLayout={onLayout}>
      {running ? <TiltSource tiltX={tiltX} tiltY={tiltY} /> : null}
      <Canvas style={StyleSheet.absoluteFill}>
        <Fill>
          <Shader source={effect} uniforms={uniforms} />
        </Fill>
      </Canvas>
    </View>
  );
}

/**
 * The stage every Screen stands on: a dark room lit by one lamp in the
 * colour of whoever the operator is talking to (src/lib/stage/lamp.ts).
 * Falls back to the still CSS-free glow if Skia cannot run the shader.
 */
export function AmbientCanvas({ parallaxY = 0, room }: AmbientCanvasProps) {
  const lights = useStageLights(room);
  const fallback = <AmbientFallback room={room} />;
  const effect = lampEffect();
  if (!effect) return fallback;
  return (
    <SkiaAmbientBoundary fallback={fallback}>
      <LampCanvas effect={effect} lights={lights} parallaxY={parallaxY} />
    </SkiaAmbientBoundary>
  );
}
