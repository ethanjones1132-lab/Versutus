import { useRef, type ReactNode } from 'react';
import { StyleSheet, View, type GestureResponderEvent, type ViewStyle } from 'react-native';
import Animated, { Easing, Keyframe } from 'react-native-reanimated';
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { Palette } from '@/constants/tokens';
import { haptics } from '@/lib/haptics';
import { hexAlpha } from '@/lib/stage/composer-light';
import {
  WHEEL_SEAMS,
  isSeamHue,
  openHue,
  toneName,
  wheelColour,
  wrapHue,
  type WheelRing,
} from '@/lib/avatar/wheel';

export type WheelHues = { lit: number; shade: number };

type ColourWheelProps = {
  size: number;
  lit: number;
  shade: number;
  /** Linked, the two hues turn together and keep the distance between them. */
  linked: boolean;
  onChange: (next: WheelHues) => void;
  /** The wheel holds the finger while it drags; a scrolling parent should stand still. */
  onDragChange?: (dragging: boolean) => void;
  /** Drawn in the wheel's open middle. */
  children?: ReactNode;
};

/** The rings turn into place as the wheel appears, like a dial finding its detent. */
const ringsArrive = new Keyframe({
  0: { opacity: 0, transform: [{ rotate: '-60deg' }, { scale: 0.93 }] },
  100: { opacity: 1, transform: [{ rotate: '0deg' }, { scale: 1 }], easing: Easing.out(Easing.cubic) },
}).duration(640);

/** How finely the rings are cut, in degrees per segment. */
const STEP = 3;
const SEAM_DOT: Record<(typeof WHEEL_SEAMS)[number]['status'], string> = {
  failed: Palette.statusDisconnected,
  waiting: Palette.statusConnecting,
  connected: Palette.statusConnected,
};

type Rings = {
  c: number;
  lit: { outer: number; inner: number; mid: number };
  shade: { outer: number; inner: number; mid: number };
  hole: number;
};

export function wheelRings(size: number): Rings {
  const c = size / 2;
  const litOuter = c - 14;
  const litInner = litOuter - 26;
  const shadeOuter = litInner - 9;
  const shadeInner = shadeOuter - 17;
  return {
    c,
    lit: { outer: litOuter, inner: litInner, mid: (litOuter + litInner) / 2 },
    shade: { outer: shadeOuter, inner: shadeInner, mid: (shadeOuter + shadeInner) / 2 },
    hole: shadeInner - 8,
  };
}

function polar(c: number, r: number, degrees: number): [number, number] {
  const a = (degrees * Math.PI) / 180;
  return [c + r * Math.cos(a), c + r * Math.sin(a)];
}

function sector(c: number, inner: number, outer: number, from: number, to: number): string {
  const [x0, y0] = polar(c, outer, from);
  const [x1, y1] = polar(c, outer, to);
  const [x2, y2] = polar(c, inner, to);
  const [x3, y3] = polar(c, inner, from);
  const f = (v: number) => v.toFixed(2);
  return `M${f(x0)} ${f(y0)}A${outer} ${outer} 0 0 1 ${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}A${inner} ${inner} 0 0 0 ${f(x3)} ${f(y3)}Z`;
}

/**
 * The two rings, cut into segments of their own colour. Hue is laid out as
 * the angle itself — the open violets sit at the top of the wheel, where the
 * thumb rests most — and the three seams are left dark, each marked with the
 * status colour it keeps for the app.
 */
function WheelArt({ size }: { size: number }) {
  const rings = wheelRings(size);
  const segments: ReactNode[] = [];
  // The frosted seams sit over a dark bed, so they read as glass, not as the sheet.
  segments.push(<Circle key="bed-lit" cx={rings.c} cy={rings.c} r={(rings.lit.outer + rings.lit.inner) / 2} stroke="#0E0E12" strokeWidth={rings.lit.outer - rings.lit.inner} fill="none" />);
  segments.push(<Circle key="bed-shade" cx={rings.c} cy={rings.c} r={(rings.shade.outer + rings.shade.inner) / 2} stroke="#0E0E12" strokeWidth={rings.shade.outer - rings.shade.inner} fill="none" />);
  for (const ring of ['lit', 'shade'] as const) {
    const { inner, outer } = rings[ring];
    for (let hue = 0; hue < 360; hue += STEP) {
      const centre = hue + STEP / 2;
      const sealed = isSeamHue(centre);
      segments.push(
        <Path
          key={`${ring}-${hue}`}
          // A hair of overlap so no seam of background shows between segments.
          d={sector(rings.c, inner, outer, hue - 0.35, hue + STEP + 0.35)}
          fill={wheelColour(ring, centre)}
          // A sealed hue is frosted, not cut out: the wheel stays whole, and
          // the seam reads as glass the thumb cannot rest on.
          fillOpacity={sealed ? 0.13 : 1}
        />,
      );
    }
  }
  const gap = (rings.lit.inner + rings.shade.outer) / 2;
  return (
    <Svg width={size} height={size} style={StyleSheet.absoluteFill} pointerEvents="none">
      {segments}
      {/* Etched rims: the rings read as cut glass, not flat paint. */}
      {(['lit', 'shade'] as const).map((ring) => (
        <Circle key={`${ring}-rim-out`} cx={rings.c} cy={rings.c} r={rings[ring].outer} stroke="rgba(255,255,255,0.16)" strokeWidth={1} fill="none" />
      ))}
      {(['lit', 'shade'] as const).map((ring) => (
        <Circle key={`${ring}-rim-in`} cx={rings.c} cy={rings.c} r={rings[ring].inner} stroke="rgba(0,0,0,0.35)" strokeWidth={1} fill="none" />
      ))}
      {WHEEL_SEAMS.map((seam) => {
        const [x, y] = polar(rings.c, gap, seam.hue);
        return <Circle key={seam.status} cx={x} cy={y} r={3} fill={SEAM_DOT[seam.status]} />;
      })}
    </Svg>
  );
}

/**
 * The colour wheel: the stone's lit hue on the outer ring, the hue it falls
 * into on the inner one. Drag either thumb round; linked, both turn together.
 * A thumb never rests in a seam — it steps over to the seam's near edge — and
 * the wheel ticks under the finger each time the colour gets a new name.
 */
export function ColourWheel({ size, lit, shade, linked, onChange, onDragChange, children }: ColourWheelProps) {
  const rings = wheelRings(size);
  const drag = useRef<{ ring: WheelRing; originX: number; originY: number; offset: number; name: string } | null>(null);

  const hueAt = (x: number, y: number) => wrapHue((Math.atan2(y - rings.c, x - rings.c) * 180) / Math.PI);

  const apply = (ring: WheelRing, raw: number, offset: number) => {
    const moved = openHue(raw);
    const next: WheelHues =
      ring === 'lit'
        ? { lit: moved, shade: linked ? openHue(moved + offset) : shade }
        : { lit: linked ? openHue(moved - offset) : lit, shade: moved };
    const name = toneName(next.lit, next.shade);
    if (drag.current && name !== drag.current.name) {
      drag.current.name = name;
      void haptics.selection();
    }
    onChange(next);
  };

  const onGrant = (event: GestureResponderEvent) => {
    const { locationX, locationY, pageX, pageY } = event.nativeEvent;
    const distance = Math.hypot(locationX - rings.c, locationY - rings.c);
    const ring: WheelRing =
      Math.abs(distance - rings.lit.mid) <= Math.abs(distance - rings.shade.mid) ? 'lit' : 'shade';
    drag.current = {
      ring,
      originX: pageX - locationX,
      originY: pageY - locationY,
      offset: shade - lit,
      name: toneName(lit, shade),
    };
    onDragChange?.(true);
    apply(ring, hueAt(locationX, locationY), shade - lit);
  };

  const onMove = (event: GestureResponderEvent) => {
    const current = drag.current;
    if (!current) return;
    const { pageX, pageY } = event.nativeEvent;
    apply(current.ring, hueAt(pageX - current.originX, pageY - current.originY), current.offset);
  };

  const onEnd = () => {
    drag.current = null;
    onDragChange?.(false);
  };

  const step = (by: number) => {
    const offset = shade - lit;
    const next = openHue(lit + by);
    onChange({ lit: next, shade: linked ? openHue(next + offset) : shade });
    void haptics.selection();
  };

  const [lx, ly] = polar(rings.c, rings.lit.mid, lit);
  const [sx, sy] = polar(rings.c, rings.shade.mid, shade);
  const litColour = wheelColour('lit', lit);
  const shadeColour = wheelColour('shade', shade);
  const litThumb = rings.lit.outer - rings.lit.inner + 10;
  const shadeThumb = rings.shade.outer - rings.shade.inner + 10;

  return (
    <View
      style={{ width: size, height: size }}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Colour"
      accessibilityValue={{ text: toneName(lit, shade) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) => step(event.nativeEvent.actionName === 'increment' ? 15 : -15)}
      onStartShouldSetResponder={(event) => {
        const { locationX, locationY } = event.nativeEvent;
        const distance = Math.hypot(locationX - rings.c, locationY - rings.c);
        // The ring band only: the middle belongs to what is drawn there.
        return distance >= rings.hole && distance <= rings.c;
      }}
      onMoveShouldSetResponder={() => drag.current !== null}
      onResponderTerminationRequest={() => false}
      onResponderGrant={onGrant}
      onResponderMove={onMove}
      onResponderRelease={onEnd}
      onResponderTerminate={onEnd}>
      <Animated.View pointerEvents="none" entering={ringsArrive} style={StyleSheet.absoluteFill}>
        <WheelArt size={size} />
        <Svg width={size} height={size} style={StyleSheet.absoluteFill} pointerEvents="none">
          {linked ? (
            // The tether: two hues that turn as one.
            <Line x1={lx} y1={ly} x2={sx} y2={sy} stroke="rgba(255,255,255,0.55)" strokeWidth={1.5} strokeDasharray="2 3" />
          ) : null}
        </Svg>
        <View
          pointerEvents="none"
          style={[
            styles.thumb,
            thumbLight(litColour),
            { left: lx - litThumb / 2, top: ly - litThumb / 2, width: litThumb, height: litThumb, borderRadius: litThumb, backgroundColor: litColour },
          ]}
        />
        <View
          pointerEvents="none"
          style={[
            styles.thumb,
            thumbLight(shadeColour),
            { left: sx - shadeThumb / 2, top: sy - shadeThumb / 2, width: shadeThumb, height: shadeThumb, borderRadius: shadeThumb, backgroundColor: shadeColour },
          ]}
        />
      </Animated.View>
      <View
        pointerEvents="box-none"
        style={[
          styles.middle,
          { left: rings.c - rings.hole, top: rings.c - rings.hole, width: rings.hole * 2, height: rings.hole * 2, borderRadius: rings.hole },
        ]}>
        {children}
      </View>
    </View>
  );
}

function thumbLight(colour: string): ViewStyle {
  return { boxShadow: `0 2px 10px rgba(0,0,0,0.55), 0 0 14px ${hexAlpha(colour, 0.65)}` } as ViewStyle;
}

const styles = StyleSheet.create({
  thumb: {
    position: 'absolute',
    borderWidth: 3,
    borderColor: '#FFFFFF',
  },
  middle: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
