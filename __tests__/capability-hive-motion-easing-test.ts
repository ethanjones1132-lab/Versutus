declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readCapabilityHiveSource(): string {
  // capability-hive.tsx is LF on disk (preserved); read as-is.
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'gateway', 'capability-hive.tsx'].join(SEP),
    'utf8',
  );
}

// Each cell of the capability hive (capability-hive.tsx:121) used to arrive with
// a bare `FadeIn.delay(index * 28).duration(280)` import — Reanimated's default
// FadeIn easing curve is `Easing.bezier(0.193, 0.927, 0.539, 0.869)`. Every other
// FadeIn-using surface in the app routes through the `entering.fadeIn` preset at
// src/lib/motion/presets.ts:27, which chains `.duration(Motion.duration.normal)
// .easing(easings.decelerate)` — the repo rhythm. The hive is on the dashboard
// (gateway-home-dashboard.tsx) so the cell-stagger ease is one of the first
// motions a connected operator sees; with up to ~8 cells at 28ms-per-index the
// stagger lasts ~224ms, long enough for the curve to be visible.
describe('capability hive cell-stagger uses the entering.fadeIn preset', () => {
  test('imports `entering` from the motion presets module', () => {
    const src = readCapabilityHiveSource();
    expect(src).toMatch(/import\s*\{\s*entering\s*\}\s*from\s*'@\/lib\/motion\/presets';/);
  });

  test('no longer imports `FadeIn` from react-native-reanimated (it is unused now)', () => {
    const src = readCapabilityHiveSource();
    // The old import block `import Animated, { cancelAnimation, FadeIn,
    // useAnimatedStyle, useSharedValue, withRepeat, withTiming, } from
    // 'react-native-reanimated';` would re-introduce an unused name that ESLint
    // would flag. FadeIn must be gone from the source.
    expect(src).not.toMatch(/\bFadeIn\b/);
  });

  test('the cell entering animation uses `entering.fadeIn.delay(index * 28).duration(280)`', () => {
    const src = readCapabilityHiveSource();
    expect(src).toMatch(
      /<Animated\.View\s+entering=\{\s*entering\.fadeIn\.delay\(index\s*\*\s*28\)\.duration\(280\)\s*\}/,
    );
  });

  test('no call site still uses the bare `FadeIn.delay(...)` literal', () => {
    const src = readCapabilityHiveSource();
    // The pre-change literal was `FadeIn.delay(index * 28).duration(280)`; the
    // bare form must be gone now that the preset's easing curve is reused.
    const matches = src.match(/FadeIn\.delay\(/) ?? [];
    expect(matches.length).toBe(0);
  });

  test('the per-index 28ms stagger is preserved so cells still ripple in', () => {
    const src = readCapabilityHiveSource();
    // `index * 28` is the stagger; the new shape keeps it byte-identical so
    // the ripple rhythm on connect is unchanged.
    expect(src).toMatch(/index\s*\*\s*28/);
  });

  test('the per-cell 280ms duration is preserved', () => {
    const src = readCapabilityHiveSource();
    // The preset's chained `.duration(Motion.duration.normal)` (300ms) is
    // overridden by `.duration(280)` so the per-cell arrival time stays
    // byte-identical to the pre-change value.
    expect(src).toMatch(/\.duration\(280\)/);
  });
});