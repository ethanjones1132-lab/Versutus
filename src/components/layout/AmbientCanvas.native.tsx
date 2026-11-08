import { Canvas, Fill, Shader, Skia, type SkRuntimeEffect } from '@shopify/react-native-skia';
import { useIsFocused } from 'expo-router';
import { Component, useEffect, useLayoutEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { PixelRatio, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  Easing,
  SensorType,
  runOnJS,
  useAnimatedReaction,
  useAnimatedSensor,
  useAnimatedStyle,
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
import { GOVERNOR_LEVELS, governorAdvance, initialGovernor, type GovernorState } from '@/lib/stage/governor';
import { mixLights, type StageLights } from '@/lib/stage/lamp';
import { FIELD_GAIN, LAYER_TIMING, breathGain, lightCss, stageBaseCss, veilOpacity } from '@/lib/stage/layers';
import {
  STAGE_OVERSIZE_DP,
  oversizedBox,
  scaledCanvasSize,
  upscaleFactor,
  type Box,
} from '@/lib/stage/render-scale';
import { STAGE_SHADER_SKSL } from '@/lib/stage/shader';
import { getStageSignals, subscribeStageSignals } from '@/lib/stage/signals';
import { useStageLights } from '@/lib/stage/use-stage-lights';
import { useBreath } from '@/lib/motion/breath';

import { AmbientFallback, type AmbientCanvasProps } from './ambient-fallback';
import { StageGlint } from './StageGlint.native';

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
 * It renders at a fraction of the screen's resolution and is scaled back up,
 * redraws at the governor's field rate (24 a second by default), and never
 * sleeps while the screen is focused and motion is allowed: the governor
 * (src/lib/stage/governor.ts) steps it down if the phone cannot keep up.
 */
function LampCanvas({ effect, lights, parallaxY }: { effect: SkRuntimeEffect; lights: StageLights; parallaxY: number }) {
  const focused = useIsFocused();
  const reduced = useReducedMotion();
  const pixelRatio = PixelRatio.get();

  const size = useSharedValue({ width: 1, height: 1 });
  const heightValue = useSharedValue(1);
  const renderScale = useSharedValue<number>(GOVERNOR_LEVELS[0].scale);
  const governor = useSharedValue<GovernorState>(initialGovernor());
  const [box, setBox] = useState<Box | null>(null);
  const [level, setLevel] = useState(0);
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
  const workingFlag = useSharedValue(0);
  const [working, setWorking] = useState(getStageSignals().working);

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

  // The levels the room's two eased lights were last sent toward. A ref, not locals of the effect below: that
  // effect re-runs when focus or Reduce Motion change, and must not forget where the lamp really is (a latch
  // reseeded from the signal would swallow the next real change).
  const applied = useRef({ speaking: false, connection: getStageSignals().connection });

  // What the room reacts to: sends, a Bot speaking, the Gate. `apply` runs on every signal update (a touch
  // is one, about once a second while scrolling), so a timing only starts when its own value really changed:
  // a running timing writes its shared value every frame and would redraw the shader at display rate.
  useEffect(() => {
    let sendCount = getStageSignals().sendCount;
    const apply = () => {
      const signals = getStageSignals();
      if (signals.sendCount !== sendCount) {
        sendCount = signals.sendCount;
        if (!reduced && focused) {
          swell.set(0);
          swell.set(withTiming(1, { duration: LAYER_TIMING.swellMs, easing: Easing.linear }));
        }
      }
      if (signals.speaking !== applied.current.speaking) {
        applied.current.speaking = signals.speaking;
        speaking.set(
          withTiming(signals.speaking ? STAGE_GAIN.speaking : 1, {
            duration: (signals.speaking ? STAGE_TIMING.speakRiseTau : STAGE_TIMING.speakFallTau) * 2.2,
            easing: Easing.out(Easing.cubic),
          }),
        );
      }
      if (signals.connection !== applied.current.connection) {
        applied.current.connection = signals.connection;
        connection.set(
          withTiming(connectionGain(signals.connection), {
            duration: STAGE_TIMING.connectionTau * 2.2,
            easing: Easing.out(Easing.cubic),
          }),
        );
      }
      setWorking(signals.working);
    };
    return subscribeStageSignals(apply);
  }, [focused, reduced, swell, speaking, connection]);

  // The governor's level changes arrive from the UI thread through `setLevel`. The scale the uniforms
  // use follows the committed level, so the shader's resolution and the canvas size always agree.
  useLayoutEffect(() => {
    renderScale.set(GOVERNOR_LEVELS[level].scale);
  }, [level, renderScale]);

  // The air's clock: advanced on the UI thread at the governor's field rate.
  // The same callback feeds the governor the frame gaps it judges.
  const running = focused && !reduced;
  // The tool-work breath rides the shared clock, which runs only while something breathes.
  const breath = useBreath(working && running);
  // The flag follows `running` too: under Reduce Motion the breath clock never starts and sits at 0,
  // which `breathGain` would read as a 4.4% dimmer room for the whole tool run.
  useEffect(() => {
    workingFlag.set(working && running ? 1 : 0);
  }, [working, running, workingFlag]);
  // At rest nothing may write the shader's inputs: the tilt sensor writes every sample and would keep the
  // shader redrawing at the sensor rate, which would make the last rung costlier than the one above it.
  const tiltOn = running && GOVERNOR_LEVELS[level].fieldHz !== 0;
  const clock = useFrameCallback((info) => {
    'worklet';
    const dt = info.timeSincePreviousFrame ?? 0;
    // The state object lives on the UI thread and is advanced in place: a frame allocates nothing.
    const g = governor.get();
    // `runOnJS` from Reanimated, not worklets' `scheduleOnRN`: importing the worklets package whole pulls
    // its native module into every jest suite that renders a Screen, and those suites mock Reanimated only.
    if (governorAdvance(g, info.timestamp, dt)) runOnJS(setLevel)(g.level);
    const hz = GOVERNOR_LEVELS[g.level].fieldHz;
    if (hz === 0) return;
    pending.set(pending.get() + dt);
    if (pending.get() >= 1000 / hz) {
      time.set(time.get() + Math.min(pending.get(), 100) / 1000);
      pending.set(0);
    }
  }, false);
  useEffect(() => {
    clock.setActive(running);
  }, [clock, running]);

  // The field is drawn at one fixed brightness at the oversize box. Brightness is the Veil, the swell
  // is a layer, parallax and tilt move the field by transform: none of them redraw the shader.
  const uniforms = useDerivedValue(() => {
    const t = tintBlend(blend.get() * tintMs.get(), tintMs.get());
    return stageUniforms({
      width: (size.get().width + 2 * STAGE_OVERSIZE_DP) * renderScale.get(),
      height: (size.get().height + 2 * STAGE_OVERSIZE_DP) * renderScale.get(),
      pixelRatio,
      timeSec: time.get(),
      lights: mixLights(from.get(), to.get(), t),
      gain: FIELD_GAIN,
      swellElapsedMs: null,
      scroll: 0,
      tiltX: 0,
      tiltY: 0,
    });
  });

  // Everything that used to scale the lamp's gain now darkens it from above.
  const veilStyle = useAnimatedStyle(() => {
    const t = tintBlend(blend.get() * tintMs.get(), tintMs.get());
    const breathing = workingFlag.get() === 1 ? breathGain(breath.get()) : 1;
    const gain =
      lampOnGain(lampOn.get() < 1 ? lampOn.get() * STAGE_TIMING.lampOnMs : null) *
      connection.get() *
      speaking.get() *
      tintDipGain(t) *
      breathing;
    return { opacity: veilOpacity(gain) };
  });

  // Parallax and tilt as a transform of the field layer: at most 10 dp in total, inside the 12 dp oversize.
  const fieldStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tiltX.get() * 10 },
      { translateY: -scroll.get() * 6 + tiltY.get() * 4 },
    ],
  }));

  const veilColor = useMemo(() => stageBaseCss(), []);
  const swellCore = useMemo(() => lightCss(lights.key.core, 0.5), [lights]);
  const swellClear = useMemo(() => lightCss(lights.key.core, 0), [lights]);

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    const next = { width: Math.max(1, width), height: Math.max(1, height) };
    size.set(next);
    heightValue.set(next.height);
    setBox(next);
  };

  const fieldBox = box ? oversizedBox(box) : null;
  const canvas = fieldBox ? scaledCanvasSize(fieldBox, GOVERNOR_LEVELS[level].scale) : null;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} onLayout={onLayout}>
      {tiltOn ? <TiltSource tiltX={tiltX} tiltY={tiltY} /> : null}
      {fieldBox && canvas ? (
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: 'absolute',
              left: -STAGE_OVERSIZE_DP,
              top: -STAGE_OVERSIZE_DP,
              width: fieldBox.width,
              height: fieldBox.height,
            },
            fieldStyle,
          ]}
        >
          {/* A smaller surface, scaled back up from the top-left to fill the oversize field. */}
          <Canvas
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: canvas.width,
              height: canvas.height,
              transformOrigin: 'top left',
              transform: [{ scale: upscaleFactor(fieldBox, canvas) }],
            }}
          >
            <Fill>
              <Shader source={effect} uniforms={uniforms} />
            </Fill>
          </Canvas>
        </Animated.View>
      ) : null}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: veilColor }, veilStyle]} />
      <StageGlint swell={swell} stageHeight={heightValue} core={swellCore} clear={swellClear} />
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
