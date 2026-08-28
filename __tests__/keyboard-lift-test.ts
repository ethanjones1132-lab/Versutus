import { composerKeyboardLift } from '@/lib/motion/keyboard-lift';

test('closed keyboard keeps bottom inset clearance (dock above nav bar)', () => {
  expect(composerKeyboardLift(0, 24)).toBe(24);
  expect(composerKeyboardLift(-10, 24)).toBe(24);
});

test('open keyboard subtracts the bottom inset already applied by Screen', () => {
  expect(composerKeyboardLift(320, 24)).toBe(296);
});

test('keyboard shorter than the inset does not go negative', () => {
  expect(composerKeyboardLift(16, 24)).toBe(0);
});

test('non-finite values keep inset when keyboard unknown', () => {
  expect(composerKeyboardLift(Number.NaN, 24)).toBe(24);
  expect(composerKeyboardLift(320, Number.NaN)).toBe(320);
});

test('the lift helper is a worklet — it is called from the UI thread', () => {
  // ComposerKeyboardLift calls this from inside useAnimatedStyle, and only on
  // Android (`Platform.OS === 'android' ? composerKeyboardLift(...) : 0`).
  // Without the 'worklet' directive the Babel plugin cannot hoist it, so it is
  // captured into the worklet's __closure as a plain JS function and invoking
  // it on the UI thread kills the process — "Versutus keeps stopping" the
  // instant any chat or Bot opened, iOS unaffected because the ternary
  // short-circuits there.
  const marked = composerKeyboardLift as unknown as { __workletHash?: number };
  expect(typeof marked.__workletHash).toBe('number');
});
