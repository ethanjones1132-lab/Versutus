// Contract + geometry tests for the swipe-to-dismiss sheet (CHARTER priority 5,
// visual-direction-2026-09.md: "Sheets — grab handle + swipe-to-dismiss on
// BaseSheet").
//
// The thresholds live in `src/lib/motion/sheet-swipe.ts` as pure functions
// precisely so they can be pinned here without mounting a Modal, and so the
// PanResponder in BaseSheet carries no numbers of its own. The source
// contracts at the bottom guard the two things that are easy to undo: the grab
// zone actually owning the pan handlers, and the gesture staying gated on
// `onClose`.

import {
  SHEET_SWIPE,
  sheetSwipeOffset,
  sheetSwipeShouldDismiss,
  sheetSwipeVelocity,
} from '@/lib/motion/sheet-swipe';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readBaseSheet(): string {
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'components', 'ui', 'BaseSheet.tsx'].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

// The offset BaseSheet animates to when closed: 400px past the anchored edge.
const HIDDEN = 400;

describe('a dragged sheet follows the finger toward dismissal', () => {
  test('a bottom sheet follows a downward drag 1:1', () => {
    expect(sheetSwipeOffset({ delta: 40, position: 'bottom', hiddenTravel: HIDDEN })).toBe(40);
    expect(sheetSwipeOffset({ delta: 119, position: 'bottom', hiddenTravel: HIDDEN })).toBe(119);
  });

  test('a top sheet follows an upward drag 1:1, so the same finger travel moves the opposite way', () => {
    // dy is screen-space: up is negative. A top sheet dismisses upward, so the
    // offset is negative too.
    expect(sheetSwipeOffset({ delta: -40, position: 'top', hiddenTravel: -HIDDEN })).toBe(-40);
    expect(sheetSwipeOffset({ delta: 40, position: 'bottom', hiddenTravel: HIDDEN })).toBe(40);
  });

  test('a drag never runs past the offset the close animation uses', () => {
    // 3000px of finger is still only the 400px hidden offset: the sheet parks
    // exactly where the existing close animation would have left it, so the
    // hand-off to onClose is invisible.
    expect(sheetSwipeOffset({ delta: 3000, position: 'bottom', hiddenTravel: HIDDEN })).toBe(HIDDEN);
    expect(sheetSwipeOffset({ delta: -3000, position: 'top', hiddenTravel: -HIDDEN })).toBe(-HIDDEN);
  });

  test('rest is zero on either edge', () => {
    expect(sheetSwipeOffset({ delta: 0, position: 'bottom', hiddenTravel: HIDDEN })).toBe(0);
    expect(sheetSwipeOffset({ delta: 0, position: 'top', hiddenTravel: -HIDDEN })).toBe(0);
  });
});

describe('pulling away from dismissal resists instead of opening a second way out', () => {
  test('a wrong-way drag gives back a fifth of the travel', () => {
    expect(sheetSwipeOffset({ delta: -200, position: 'bottom', hiddenTravel: HIDDEN })).toBe(-40);
    expect(sheetSwipeOffset({ delta: 200, position: 'top', hiddenTravel: -HIDDEN })).toBe(40);
  });

  test('the give-back is capped, so a long wrong-way drag cannot lift the sheet off', () => {
    expect(sheetSwipeOffset({ delta: -900, position: 'bottom', hiddenTravel: HIDDEN })).toBe(-80);
    expect(sheetSwipeOffset({ delta: 900, position: 'top', hiddenTravel: -HIDDEN })).toBe(80);
  });

  test('the resistance and the ceiling are the documented numbers', () => {
    expect(SHEET_SWIPE.resistance).toBe(0.2);
    expect(SHEET_SWIPE.maxLift).toBe(80);
  });

  test('a wrong-way drag never crosses over into the dismissing direction', () => {
    const lifted = sheetSwipeOffset({ delta: -5, position: 'bottom', hiddenTravel: HIDDEN });
    expect(lifted).toBeLessThan(0);
    expect(sheetSwipeOffset({ delta: -10000, position: 'bottom', hiddenTravel: HIDDEN })).toBeLessThan(0);
    expect(sheetSwipeOffset({ delta: 10000, position: 'top', hiddenTravel: -HIDDEN })).toBeGreaterThan(0);
  });
});

describe('the offset is absolute, not accumulated', () => {
  test('a bad measurement falls back to rest rather than teleporting the sheet', () => {
    // PanResponder has been known to report a non-finite dy mid-gesture; the
    // sheet must park at rest rather than jump to the hidden offset.
    expect(sheetSwipeOffset({ delta: Number.NaN, position: 'bottom', hiddenTravel: HIDDEN })).toBe(0);
    expect(
      sheetSwipeOffset({ delta: 120, position: 'bottom', hiddenTravel: Number.NaN }),
    ).toBe(0);
    expect(
      sheetSwipeOffset({
        delta: Number.POSITIVE_INFINITY,
        position: 'bottom',
        hiddenTravel: HIDDEN,
      }),
    ).toBe(0);
  });
});

describe('releasing the drag', () => {
  test('a long slow pull closes the sheet on travel alone', () => {
    expect(sheetSwipeShouldDismiss({ travel: SHEET_SWIPE.dismissTravel, velocity: 0 })).toBe(true);
    expect(sheetSwipeShouldDismiss({ travel: 400, velocity: 0 })).toBe(true);
  });

  test('a short fast flick closes the sheet without reaching the travel bar', () => {
    expect(sheetSwipeShouldDismiss({ travel: 40, velocity: SHEET_SWIPE.dismissFlick })).toBe(true);
    expect(sheetSwipeShouldDismiss({ travel: 40, velocity: 2 })).toBe(true);
  });

  test('a flick with almost no travel behind it does not close the sheet', () => {
    // The failure this guards: a 0.5px/ms tremor during a tap on the header
    // would otherwise close the sheet the user was reaching into.
    expect(SHEET_SWIPE.flickMinTravel).toBe(24);
    expect(sheetSwipeShouldDismiss({ travel: 8, velocity: 3 })).toBe(false);
    expect(sheetSwipeShouldDismiss({ travel: 0, velocity: 3 })).toBe(false);
  });

  test('a short slow drag goes back to rest', () => {
    expect(sheetSwipeShouldDismiss({ travel: 100, velocity: 0.1 })).toBe(false);
    expect(sheetSwipeShouldDismiss({ travel: 24, velocity: 0.4 })).toBe(false);
  });

  test('neither bar is cleared by a bad measurement', () => {
    expect(sheetSwipeShouldDismiss({ travel: Number.NaN, velocity: 9 })).toBe(false);
    expect(sheetSwipeShouldDismiss({ travel: 500, velocity: Number.NaN })).toBe(true);
    expect(sheetSwipeShouldDismiss({ travel: 40, velocity: Number.NaN })).toBe(false);
  });

  test('the two bars are the documented numbers', () => {
    expect(SHEET_SWIPE.dismissTravel).toBe(120);
    expect(SHEET_SWIPE.dismissFlick).toBe(0.5);
    expect(SHEET_SWIPE.claim).toBe(8);
  });
});

describe('velocity is mirrored to the dismissing direction', () => {
  test('a downward flick on a bottom sheet reads as closing', () => {
    expect(sheetSwipeVelocity({ vy: 1.2, position: 'bottom' })).toBeCloseTo(1.2);
  });

  test('an upward flick on a top sheet reports the same positive magnitude', () => {
    // PanResponder gives px/ms in screen space: a top sheet dismissing upward
    // arrives as a negative vy, and must not read as a flick the wrong way.
    expect(sheetSwipeVelocity({ vy: -1.2, position: 'top' })).toBeCloseTo(1.2);
  });

  test('a flick away from dismissal reads as negative, so it clears no bar', () => {
    // A hard upward flick on a bottom sheet must not dismiss it. Keeping the
    // sign here is what guarantees that: dismissFlick is a positive bar.
    expect(sheetSwipeVelocity({ vy: -1.2, position: 'bottom' })).toBeCloseTo(-1.2);
    expect(sheetSwipeVelocity({ vy: 1.2, position: 'top' })).toBeCloseTo(-1.2);
    expect(
      sheetSwipeShouldDismiss({
        travel: 40,
        velocity: sheetSwipeVelocity({ vy: -1.2, position: 'bottom' }),
      }),
    ).toBe(false);
  });

  test('a bad velocity measurement is zero', () => {
    expect(sheetSwipeVelocity({ vy: Number.NaN, position: 'bottom' })).toBe(0);
  });
});

describe('BaseSheet carries the gesture, and carries no numbers of its own', () => {
  test('the grab zone owns the pan handlers, not the scrollable content', () => {
    const src = readBaseSheet();
    expect(src).toContain('panResponder.panHandlers');
    expect(src).toMatch(/<View \{\.\.\.panResponder\.panHandlers\} style=\{styles\.grabZone\}>/);
    // The handle and the header are inside the grab zone, so the drag works
    // from either without an invisible target wider than the visible one.
    const grabZoneAt = src.indexOf('styles.grabZone}>');
    const handleAt = src.indexOf('styles.grabHandle');
    const headerAt = src.indexOf('{header}');
    expect(grabZoneAt).toBeGreaterThan(-1);
    expect(handleAt).toBeGreaterThan(grabZoneAt);
    expect(headerAt).toBeGreaterThan(handleAt);
  });

  test('a touch-down stays a tap, and only vertical intent claims the drag', () => {
    const src = readBaseSheet();
    expect(src).toContain('onStartShouldSetPanResponder: () => false');
    expect(src).toMatch(/onMoveShouldSetPanResponder: \(_event, gesture\) =>\s*Math\.abs\(gesture\.dy\) > SHEET_SWIPE\.claim/);
    // The responder is memoised, so a re-render cannot swap it mid-gesture.
    expect(src).toMatch(/const panResponder = useMemo\(/);
    expect(src).toContain('PanResponder.create({');
  });

  test('the drag reads the pure helpers, and the sheet carries no inline thresholds', () => {
    const src = readBaseSheet();
    expect(src).toContain('sheetSwipeOffset({');
    expect(src).toContain('sheetSwipeShouldDismiss({');
    expect(src).toContain('sheetSwipeVelocity({ vy: gesture.vy, position })');
    // Every threshold lives in sheet-swipe.ts; a literal here would drift from
    // the module the tests pin.
    expect(src).not.toMatch(/dy\s*[<>]\s*\d/);
    expect(src).not.toMatch(/vy\s*[<>]\s*[\d.]/);
  });

  test('the handle is a quiet pill, not a button', () => {
    const src = readBaseSheet();
    const handle = src.match(/grabHandle: \{[\s\S]*?\n  \},/)?.[0] ?? '';
    expect(handle).toContain('width: 36');
    expect(handle).toContain('height: 4');
    expect(handle).toContain('borderRadius: Radius.full');
    expect(handle).toContain('backgroundColor: Palette.borderStrong');
    // A handle is a shape, not a control: it takes no label, no role and no
    // press handler of its own.
    expect(handle).not.toMatch(/accessibility|onPress/);
  });

  test('a sheet that cannot be closed never advertises the gesture', () => {
    const src = readBaseSheet();
    // Both the handle and the drag surface hang off `onClose`, exactly like the
    // Close control they replace.
    expect(src).toMatch(/\{onClose \? \(\s*<View \{\.\.\.panResponder\.panHandlers\}/);
    expect(src).toMatch(/\)\s*:\s*\(\s*header\s*\)/);
  });

  test('a released drag either settles home or hands off to the existing close', () => {
    const src = readBaseSheet();
    // Settle home: back to rest, no prop change.
    expect(src).toContain('translateY.value = withTiming(0, {');
    // Commit: fly to the hidden offset AND call onClose, so the parent's
    // visible=false re-runs the same target and unmounts through the existing
    // lazy-mount path rather than a second, parallel exit.
    expect(src).toContain('translateY.value = withTiming(hiddenOffset, {');
    expect(src).toMatch(/flyOut\(\);\s*onClose\?\.\(\);/);
    expect(src).toContain('onPanResponderTerminate: () => settleBack()');
  });

  test('the open/close animation, backdrop dismiss and haptics are untouched', () => {
    const src = readBaseSheet();
    expect(src).toContain('translateY.value = withTiming(');
    expect(src).toContain('duration: Motion.duration.normal,');
    expect(src).toContain('easing: Easing.out(Easing.cubic),');
    expect(src).toContain('if (finished && !visible)');
    expect(src).toContain('runOnJS(setMounted)(false)');
    expect(src).toContain('accessibilityLabel="Dismiss sheet"');
    expect(src).toContain('Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)');
    expect(src).toContain('onRequestClose={onClose}');
    expect(src).toContain('if (!mounted) return null;');
  });

  test('the only lint suppressions are the repo-standard reanimated ones', () => {
    // Iterations 196–201 all reset on `react-hooks/immutability` and
    // `react-hooks/refs` while reaching for this item. The drag origin is
    // absolute (gesture.dy, not an accumulated ref), so no ref is handed to
    // the responder; every suppression is a shared-value write, which is the
    // pattern src/lib/motion/hooks.ts already established.
    const src = readBaseSheet();
    const suppressions = src.match(/eslint-disable-next-line[^\n]*/g) ?? [];
    expect(suppressions.length).toBeGreaterThan(0);
    for (const line of suppressions) {
      expect(line).toContain('react-hooks/immutability');
    }
    expect(src).not.toMatch(/useRef/);
    expect(src).not.toMatch(/eslint-disable(?!-next-line react-hooks\/immutability)/);
  });
});
