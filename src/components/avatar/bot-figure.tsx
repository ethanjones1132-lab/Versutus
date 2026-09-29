import { useEffect, useId } from 'react';
import { StyleSheet, Text as RNText, View, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Defs, Ellipse, LinearGradient, Path, RadialGradient, Stop } from 'react-native-svg';

import { FontFamily } from '@/constants/tokens';
import { FORM_GEOMETRY } from '@/lib/avatar/forms';
import { FACE_INK_DARK, FACE_INK_LIGHT, faceInkIsDark, type BotLook } from '@/lib/avatar/look';
import { fnv1a } from '@/lib/bot-avatar';
import { hexAlpha } from '@/lib/stage/composer-light';

/** What the Bot is doing, as far as its face is concerned. */
export type FigureMood = 'idle' | 'thinking';

export type BotFigureProps = {
  look: BotLook;
  /** Width and height in points. */
  size: number;
  /** Whose figure this is: it seeds the rhythm, so a roster never blinks in unison. */
  seed: string;
  mood?: FigureMood;
  /** Off for figures drawn as swatches; the face then holds still. */
  animated?: boolean;
  /** The eyes open as the figure first appears — the Bot looking up as you arrive. */
  wake?: boolean;
  /** Bump to make the Bot light up at a touch: a smile of the eyes and a swell of light. */
  reaction?: number;
  /**
   * Draw a keyline in this colour round the silhouette, so figures overlapped
   * in a group crest read as separate people whatever their form.
   */
  cutout?: string;
};

/** Below this size a face is drawn but kept still: a 26pt row is not a stage. */
const ANIMATE_FROM = 30;
/** Below this, the ink carries no glow; it would only blur a two-point eye. */
const GLOW_FROM = 40;
/** How far the cutout viewBox reaches past the silhouette, in units. */
const CUT_MARGIN = 7;

/** A small, fast, seeded generator: the same Bot keeps the same rhythm. */
function seeded(seed: string): () => number {
  let a = fnv1a(seed) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type FaceAnim = {
  blink: SharedValue<number>;
  gazeX: SharedValue<number>;
  gazeY: SharedValue<number>;
  think: SharedValue<number>;
  joy: SharedValue<number>;
  cycle: SharedValue<number>;
};

type FaceProps = {
  /** The eye line's centre and the face's width, in points. */
  cx: number;
  cy: number;
  w: number;
  ink: string;
  glow: boolean;
  tone: BotLook['tone'];
  initial: string;
  anim: FaceAnim;
};

/**
 * A Bot drawn in the Versutus manner: a cut stone in its own colour, lit from
 * the upper left like everything on the stage, wearing a face that lives —
 * it blinks on its own rhythm, glances about, looks up and away while the
 * Bot is thinking, and smiles with its eyes when touched.
 */
export function BotFigure({
  look,
  size,
  seed,
  mood = 'idle',
  animated = true,
  wake = false,
  reaction = 0,
  cutout,
}: BotFigureProps) {
  const reduced = useReducedMotion();
  const live = animated && !reduced && size >= ANIMATE_FROM;

  const blink = useSharedValue(live && wake ? 0.06 : 1);
  const gazeX = useSharedValue(0);
  const gazeY = useSharedValue(0);
  const breath = useSharedValue(0);
  const think = useSharedValue(mood === 'thinking' ? 1 : 0);
  const joy = useSharedValue(0);
  const cycle = useSharedValue(0);
  const pulse = useSharedValue(0);

  // The figure's own life: blinks, glances and breath, each on a rhythm drawn
  // from the Bot's id so no two figures on a screen move together.
  useEffect(() => {
    if (!live) {
      for (const value of [blink, gazeX, gazeY, breath, cycle, pulse]) cancelAnimation(value);
      blink.set(1);
      gazeX.set(0);
      gazeY.set(0);
      breath.set(0);
      cycle.set(0);
      return;
    }
    const rand = seeded(seed);
    const span = (lo: number, hi: number) => lo + (hi - lo) * rand();
    const close = () =>
      withSequence(
        withTiming(0.06, { duration: 70, easing: Easing.in(Easing.quad) }),
        withTiming(1, { duration: 140, easing: Easing.out(Easing.quad) }),
      );
    const blinking = withRepeat(
      withSequence(
        withDelay(span(2600, 4200), close()),
        withDelay(span(3400, 5600), close()),
        // Now and then a double blink, the way a person resets.
        withDelay(span(2800, 4800), withSequence(close(), withDelay(90, close()))),
      ),
      -1,
    );
    blink.set(
      wake
        ? withSequence(withDelay(380, withTiming(1, { duration: 280, easing: Easing.out(Easing.cubic) })), blinking)
        : blinking,
    );
    const glance = (axis: number) =>
      withRepeat(
        withSequence(
          withDelay(span(1800, 3600), withTiming(span(-1, 1) * axis, { duration: 380, easing: Easing.inOut(Easing.cubic) })),
          withDelay(span(900, 2200), withTiming(span(-1, 1) * axis, { duration: 420, easing: Easing.inOut(Easing.cubic) })),
          withDelay(span(1200, 2600), withTiming(0, { duration: 460, easing: Easing.inOut(Easing.cubic) })),
        ),
        -1,
      );
    gazeX.set(glance(1));
    gazeY.set(glance(0.6));
    breath.set(withRepeat(withTiming(1, { duration: span(3800, 4600), easing: Easing.inOut(Easing.sin) }), -1, true));
    cycle.set(withRepeat(withTiming(1, { duration: 2000, easing: Easing.linear }), -1));
    pulse.set(withRepeat(withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.sin) }), -1, true));
    return () => {
      for (const value of [blink, gazeX, gazeY, breath, cycle, pulse]) cancelAnimation(value);
    };
  }, [live, seed, wake, blink, gazeX, gazeY, breath, cycle, pulse]);

  useEffect(() => {
    const target = mood === 'thinking' ? 1 : 0;
    think.set(live ? withTiming(target, { duration: 420, easing: Easing.inOut(Easing.cubic) }) : target);
  }, [mood, live, think]);

  useEffect(() => {
    if (reaction === 0 || !live) return;
    joy.set(
      withSequence(
        withTiming(1, { duration: 160, easing: Easing.out(Easing.cubic) }),
        withDelay(720, withTiming(0, { duration: 360, easing: Easing.inOut(Easing.cubic) })),
      ),
    );
  }, [reaction, live, joy]);

  const figureStyle = useAnimatedStyle(() => ({
    // A breath, and a swell when touched — the stone grows by a hair, never bounces.
    transform: [{ scale: 1 + 0.014 * breath.get() + 0.035 * joy.get() }],
  }));
  const auraStyle = useAnimatedStyle(() => ({
    opacity: think.get() * (0.35 + 0.45 * pulse.get()) + joy.get() * 0.55,
    transform: [{ scale: 0.92 + 0.08 * pulse.get() * think.get() + 0.1 * joy.get() }],
  }));

  const geometry = FORM_GEOMETRY[look.form];
  const reach = cutout ? 100 + CUT_MARGIN * 2 : 100;
  const k = size / reach;
  const offset = cutout ? CUT_MARGIN : 0;
  const dark = faceInkIsDark(look.tone);
  const ink = dark ? FACE_INK_DARK : FACE_INK_LIGHT;
  const anim: FaceAnim = { blink, gazeX, gazeY, think, joy, cycle };
  const face: FaceProps = {
    cx: (geometry.face.x + offset) * k,
    cy: (geometry.face.y + offset) * k,
    w: geometry.face.w * k,
    ink,
    glow: !dark && size >= GLOW_FROM,
    tone: look.tone,
    initial: look.initial,
    anim,
  };

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width: size, height: size }, live ? figureStyle : null]}>
      {live ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.aura,
            {
              left: size * 0.06,
              top: size * 0.06,
              width: size * 0.88,
              height: size * 0.88,
              borderRadius: size,
              backgroundColor: hexAlpha(look.tone.from, 0.18),
              boxShadow: `0 0 ${Math.round(size * 0.32)}px ${hexAlpha(look.tone.from, 0.7)}`,
            } as ViewStyle,
            auraStyle,
          ]}
        />
      ) : null}
      {size >= GLOW_FROM && !cutout ? (
        // Seated in the light: a soft pool of the stone's own colour beneath it.
        <View
          pointerEvents="none"
          style={[
            styles.abs,
            {
              left: size * 0.18,
              top: size * 0.3,
              width: size * 0.64,
              height: size * 0.6,
              borderRadius: size,
              boxShadow: `0 ${Math.round(size * 0.1)}px ${Math.round(size * 0.34)}px ${hexAlpha(look.tone.to, 0.55)}`,
            } as ViewStyle,
          ]}
        />
      ) : null}
      <FigureBody look={look} size={size} cutout={cutout} />
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <FaceLayer kind={look.face} {...face} />
      </View>
    </Animated.View>
  );
}

/** The stone: body, table, depth, sheen, facets, a catchlight and the rim. */
function FigureBody({ look, size, cutout }: { look: BotLook; size: number; cutout?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const geometry = FORM_GEOMETRY[look.form];
  const box = cutout ? `${-CUT_MARGIN} ${-CUT_MARGIN} ${100 + CUT_MARGIN * 2} ${100 + CUT_MARGIN * 2}` : '0 0 100 100';
  const unit = (cutout ? 100 + CUT_MARGIN * 2 : 100) / size;
  // Hairlines stay a physical ~0.75pt at every size.
  const rim = Math.max(0.75, size / 48) * unit;
  const ids = {
    body: `fb-${uid}`,
    sheen: `fs-${uid}`,
    rim: `fr-${uid}`,
    depth: `fd-${uid}`,
    table: `ft-${uid}`,
  };
  const { sheen } = geometry;

  return (
    <Svg width={size} height={size} viewBox={box} style={StyleSheet.absoluteFill}>
      <Defs>
        <LinearGradient id={ids.body} x1="0.15" y1="0" x2="0.85" y2="1">
          <Stop offset="0" stopColor={look.tone.from} />
          <Stop offset="1" stopColor={look.tone.to} />
        </LinearGradient>
        <RadialGradient id={ids.sheen} cx={sheen.x} cy={sheen.y} rx="0.62" ry="0.5" fx={sheen.x} fy={sheen.y}>
          <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.36} />
          <Stop offset="0.55" stopColor="#FFFFFF" stopOpacity={0.06} />
          <Stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id={ids.depth} cx="0.78" cy="0.9" rx="0.7" ry="0.6" fx="0.78" fy="0.9">
          <Stop offset="0" stopColor="#000000" stopOpacity={0.26} />
          <Stop offset="1" stopColor="#000000" stopOpacity={0} />
        </RadialGradient>
        <LinearGradient id={ids.rim} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.5} />
          <Stop offset="0.5" stopColor="#FFFFFF" stopOpacity={0.1} />
          <Stop offset="1" stopColor="#000000" stopOpacity={0.3} />
        </LinearGradient>
        <LinearGradient id={ids.table} x1="0.2" y1="0" x2="0.8" y2="1">
          <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.2} />
          <Stop offset="1" stopColor="#FFFFFF" stopOpacity={0.03} />
        </LinearGradient>
      </Defs>
      {cutout ? <Path d={geometry.body} fill={cutout} stroke={cutout} strokeWidth={CUT_MARGIN * 1.2} strokeLinejoin="round" /> : null}
      <Path d={geometry.body} fill={`url(#${ids.body})`} />
      {geometry.table ? <Path d={geometry.table} fill={`url(#${ids.table})`} /> : null}
      <Path d={geometry.body} fill={`url(#${ids.depth})`} />
      <Path d={geometry.body} fill={`url(#${ids.sheen})`} />
      {geometry.facets ? (
        <Path d={geometry.facets} fill="none" stroke="#FFFFFF" strokeOpacity={0.2} strokeWidth={rim * 0.9} />
      ) : null}
      {size >= GLOW_FROM ? (
        // The lamp's own reflection: one small bright point on the stone.
        <Ellipse
          cx={sheen.x * 100 + 4}
          cy={sheen.y * 100 + 3}
          rx={4.2}
          ry={2.6}
          fill="#FFFFFF"
          fillOpacity={0.5}
          transform={`rotate(-32 ${sheen.x * 100 + 4} ${sheen.y * 100 + 3})`}
        />
      ) : null}
      <Path d={geometry.body} fill="none" stroke={`url(#${ids.rim})`} strokeWidth={rim} strokeLinejoin="round" />
    </Svg>
  );
}

function FaceLayer({ kind, ...face }: FaceProps & { kind: BotLook['face'] }) {
  switch (kind) {
    case 'monogram':
      return <MonogramFace {...face} />;
    case 'calm':
      return <PillEyes {...face} eyeW={0.13} eyeH={0.3} sep={0.21} />;
    case 'bright':
      return <BrightEyes {...face} />;
    case 'visor':
      return <VisorFace {...face} />;
    case 'iris':
      return <IrisFace {...face} />;
    case 'joy':
      return <ArcFace {...face} up />;
    case 'serene':
      return <ArcFace {...face} up={false} />;
    case 'pixel':
      return <PixelFace {...face} />;
    case 'starry':
      return <StarryFace {...face} />;
    default:
      return null;
  }
}

/** Where the eyes look: their own glances, drawn up and aside while thinking. */
function useGaze(anim: FaceAnim, reachX: number, reachY: number) {
  return useAnimatedStyle(() => {
    const t = anim.think.get();
    const x = anim.gazeX.get() * (1 - t) + 0.6 * t;
    const y = anim.gazeY.get() * (1 - t) - 0.7 * t;
    return { transform: [{ translateX: x * reachX }, { translateY: y * reachY - anim.joy.get() * reachY * 0.6 }] };
  });
}

function glowOf(face: FaceProps, radius: number): ViewStyle | null {
  if (!face.glow) return null;
  return { boxShadow: `0 0 ${Math.max(1, Math.round(radius))}px rgba(255,255,255,0.55)` } as ViewStyle;
}

function MonogramFace({ cx, cy, w, ink, initial, anim }: FaceProps) {
  const fontSize = Math.round(w * 0.8);
  const lineHeight = Math.round(fontSize * 1.24);
  const style = useAnimatedStyle(() => ({ opacity: 1 - 0.12 * anim.think.get() }));
  return (
    <Animated.View style={[styles.abs, { left: cx - w, top: cy - lineHeight / 2, width: w * 2, height: lineHeight }, style]}>
      <RNText
        allowFontScaling={false}
        style={[styles.initial, { fontSize, lineHeight, color: ink }, ink === FACE_INK_LIGHT ? styles.letterpress : null]}>
        {initial}
      </RNText>
    </Animated.View>
  );
}

/** Two upright pills: the calm, attentive face. */
function PillEyes({ cx, cy, w, ink, anim, eyeW, eyeH, sep, ...face }: FaceProps & { eyeW: number; eyeH: number; sep: number }) {
  const ew = w * eyeW;
  const eh = w * eyeH;
  const gaze = useGaze(anim, w * 0.07, w * 0.06);
  const lid = useAnimatedStyle(() => {
    const open = anim.blink.get() * (1 - 0.6 * anim.joy.get()) * (1 - 0.2 * anim.think.get());
    return { transform: [{ scaleY: Math.max(0.06, open) }] };
  });
  return (
    <Animated.View style={[styles.abs, { left: cx - w / 2, top: cy - eh / 2, width: w, height: eh }, gaze]}>
      {[-1, 1].map((side) => (
        <Animated.View
          key={side}
          style={[
            styles.abs,
            { left: w / 2 + side * w * sep - ew / 2, top: 0, width: ew, height: eh, borderRadius: ew, backgroundColor: ink },
            glowOf({ cx, cy, w, ink, anim, ...face }, ew * 0.9),
            lid,
          ]}
        />
      ))}
    </Animated.View>
  );
}

/** Round glossy eyes with a catchlight each: the bright, curious face. */
function BrightEyes({ cx, cy, w, anim }: FaceProps) {
  const d = w * 0.25;
  const gaze = useGaze(anim, w * 0.06, w * 0.05);
  const lid = useAnimatedStyle(() => {
    const open = anim.blink.get() * (1 - 0.55 * anim.joy.get());
    return { transform: [{ scaleY: Math.max(0.06, open) }] };
  });
  return (
    <Animated.View style={[styles.abs, { left: cx - w / 2, top: cy - d / 2, width: w, height: d }, gaze]}>
      {[-1, 1].map((side) => (
        <Animated.View
          key={side}
          style={[
            styles.abs,
            {
              left: w / 2 + side * w * 0.21 - d / 2,
              top: 0,
              width: d,
              height: d,
              borderRadius: d,
              backgroundColor: '#0E0D13',
              borderWidth: Math.max(0.5, d * 0.06),
              borderColor: 'rgba(255,255,255,0.35)',
            },
            lid,
          ]}>
          <View style={[styles.abs, { left: d * 0.5, top: d * 0.14, width: d * 0.32, height: d * 0.32, borderRadius: d, backgroundColor: '#FFFFFF' }]} />
          <View style={[styles.abs, { left: d * 0.26, top: d * 0.6, width: d * 0.14, height: d * 0.14, borderRadius: d, backgroundColor: 'rgba(255,255,255,0.7)' }]} />
        </Animated.View>
      ))}
    </Animated.View>
  );
}

/** A dark glass band with one bar of light sweeping it: the scanner. */
function VisorFace({ cx, cy, w, tone, anim }: FaceProps) {
  const bw = w * 0.92;
  const bh = w * 0.3;
  const light = w * 0.26;
  const travel = (bw - light - bh * 0.4) / 2;
  const scan = useAnimatedStyle(() => {
    // One sweep across and back every cycle; thinking doubles the pace.
    const phase = (anim.cycle.get() * (1 + anim.think.get())) % 1;
    const x = Math.sin(phase * Math.PI * 2) * travel;
    return { transform: [{ translateX: x }, { scaleY: Math.max(0.1, anim.blink.get()) }] };
  });
  return (
    <View
      style={[
        styles.abs,
        {
          left: cx - bw / 2,
          top: cy - bh / 2,
          width: bw,
          height: bh,
          borderRadius: bh,
          backgroundColor: 'rgba(7,7,11,0.78)',
          borderWidth: Math.max(0.5, bh * 0.06),
          borderColor: 'rgba(255,255,255,0.18)',
          overflow: 'hidden',
          alignItems: 'center',
          justifyContent: 'center',
        },
      ]}>
      <Animated.View
        style={[
          { width: light, height: bh * 0.38, borderRadius: bh, backgroundColor: '#FFFFFF' },
          { boxShadow: `0 0 ${Math.max(2, Math.round(bh * 0.6))}px ${hexAlpha(tone.from, 0.95)}` } as ViewStyle,
          scan,
        ]}
      />
    </View>
  );
}

/** One great eye, its iris in the stone's deep colour, that follows you. */
function IrisFace({ cx, cy, w, tone, anim }: FaceProps) {
  const d = w * 0.6;
  const iris = d * 0.56;
  const gaze = useGaze(anim, d * 0.16, d * 0.14);
  const lid = useAnimatedStyle(() => {
    const open = anim.blink.get() * (1 - 0.5 * anim.joy.get());
    return { transform: [{ scaleY: Math.max(0.05, open) }] };
  });
  return (
    <Animated.View
      style={[
        styles.abs,
        {
          left: cx - d / 2,
          top: cy - d / 2,
          width: d,
          height: d,
          borderRadius: d,
          backgroundColor: '#F7F6FB',
          borderWidth: Math.max(0.6, d * 0.05),
          borderColor: 'rgba(0,0,0,0.28)',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        },
        lid,
      ]}>
      <Animated.View style={[{ width: iris, height: iris, borderRadius: iris, backgroundColor: tone.to, alignItems: 'center', justifyContent: 'center' }, gaze]}>
        <View style={{ width: iris * 0.46, height: iris * 0.46, borderRadius: iris, backgroundColor: '#09080D' }} />
        <View style={[styles.abs, { left: iris * 0.56, top: iris * 0.16, width: iris * 0.24, height: iris * 0.24, borderRadius: iris, backgroundColor: '#FFFFFF' }]} />
      </Animated.View>
    </Animated.View>
  );
}

/** Eyes drawn as arcs: smiling (joy) or softly closed (serene), with a small mouth. */
function ArcFace({ cx, cy, w, ink, anim, up }: FaceProps & { up: boolean }) {
  const ew = w * 0.26;
  const eh = w * 0.14;
  const stroke = Math.max(1, w * 0.065);
  const mouthW = w * (up ? 0.22 : 0.14);
  const gaze = useGaze(anim, w * 0.04, w * 0.03);
  const breathe = useAnimatedStyle(() => ({
    transform: [{ scaleY: 1 + 0.25 * anim.joy.get() }],
  }));
  const eye = up
    ? `M${stroke} ${eh - stroke / 2}Q${ew / 2} ${-eh * 0.7} ${ew - stroke} ${eh - stroke / 2}`
    : `M${stroke} ${stroke}Q${ew / 2} ${eh * 1.5} ${ew - stroke} ${stroke}`;
  const mouth = `M${stroke} ${stroke}Q${mouthW / 2} ${eh * 1.2} ${mouthW - stroke} ${stroke}`;
  return (
    <Animated.View style={[styles.abs, { left: cx - w / 2, top: cy - eh / 2, width: w, height: w * 0.62 }, gaze]}>
      {[-1, 1].map((side) => (
        <Animated.View key={side} style={[styles.abs, { left: w / 2 + side * w * 0.21 - ew / 2, top: 0, width: ew, height: eh }, breathe]}>
          <Svg width={ew} height={eh}>
            <Path d={eye} stroke={ink} strokeWidth={stroke} strokeLinecap="round" fill="none" />
          </Svg>
        </Animated.View>
      ))}
      <View style={[styles.abs, { left: w / 2 - mouthW / 2, top: eh + w * 0.14, width: mouthW, height: eh }]}>
        <Svg width={mouthW} height={eh}>
          <Path d={mouth} stroke={ink} strokeWidth={stroke * 0.9} strokeLinecap="round" fill="none" />
        </Svg>
      </View>
    </Animated.View>
  );
}

/** Square eyes that blink in one frame, and a flat line of a mouth: the machine. */
function PixelFace({ cx, cy, w, ink, anim, ...face }: FaceProps) {
  const e = w * 0.17;
  const gaze = useGaze(anim, w * 0.08, w * 0.05);
  const lid = useAnimatedStyle(() => {
    // A pixel blink has no in-between: open, or one line.
    const open = anim.blink.get() > 0.5 && anim.joy.get() < 0.5 ? 1 : 0.18;
    return { transform: [{ scaleY: open }] };
  });
  return (
    <Animated.View style={[styles.abs, { left: cx - w / 2, top: cy - e / 2, width: w, height: w * 0.6 }, gaze]}>
      {[-1, 1].map((side) => (
        <Animated.View
          key={side}
          style={[
            styles.abs,
            { left: w / 2 + side * w * 0.2 - e / 2, top: 0, width: e, height: e, borderRadius: e * 0.14, backgroundColor: ink },
            glowOf({ cx, cy, w, ink, anim, ...face }, e * 0.8),
            lid,
          ]}
        />
      ))}
      <View style={[styles.abs, { left: w / 2 - w * 0.1, top: e + w * 0.13, width: w * 0.2, height: Math.max(1, w * 0.05), backgroundColor: ink, opacity: 0.9 }]} />
    </Animated.View>
  );
}

const STAR = (d: number) => {
  const c = d / 2;
  const i = d * 0.13;
  return `M${c} 0Q${c + i} ${c - i} ${d} ${c}Q${c + i} ${c + i} ${c} ${d}Q${c - i} ${c + i} 0 ${c}Q${c - i} ${c - i} ${c} 0Z`;
};

/** Four-point stars for eyes, turning slowly and twinkling as they blink. */
function StarryFace({ cx, cy, w, ink, anim }: FaceProps) {
  const d = w * 0.32;
  const gaze = useGaze(anim, w * 0.05, w * 0.04);
  const twinkle = useAnimatedStyle(() => ({
    transform: [
      { rotate: `${anim.cycle.get() * 90 * (1 + anim.think.get())}deg` },
      { scale: Math.max(0.2, 0.55 + 0.45 * anim.blink.get()) * (1 + 0.2 * anim.joy.get()) },
    ],
  }));
  return (
    <Animated.View style={[styles.abs, { left: cx - w / 2, top: cy - d / 2, width: w, height: d }, gaze]}>
      {[-1, 1].map((side) => (
        <Animated.View key={side} style={[styles.abs, { left: w / 2 + side * w * 0.22 - d / 2, top: 0, width: d, height: d }, twinkle]}>
          <Svg width={d} height={d}>
            <Path d={STAR(d)} fill={ink} />
          </Svg>
        </Animated.View>
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  abs: {
    position: 'absolute',
  },
  aura: {
    position: 'absolute',
  },
  initial: {
    fontFamily: FontFamily.serif,
    textAlign: 'center',
  },
  letterpress: {
    // Letterpress: the initial sits pressed into the stone, not floating on it.
    textShadowColor: 'rgba(0, 0, 0, 0.32)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 1.5,
  },
});
