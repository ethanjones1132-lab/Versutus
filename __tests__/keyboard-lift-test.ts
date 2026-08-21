import { composerKeyboardLift } from '@/lib/motion/keyboard-lift';

test('closed keyboard does not lift', () => {
  expect(composerKeyboardLift(0, 24)).toBe(0);
  expect(composerKeyboardLift(-10, 24)).toBe(0);
});

test('open keyboard subtracts the bottom inset already applied by Screen', () => {
  expect(composerKeyboardLift(320, 24)).toBe(296);
});

test('keyboard shorter than the inset does not go negative', () => {
  expect(composerKeyboardLift(16, 24)).toBe(0);
});

test('non-finite values lift nothing', () => {
  expect(composerKeyboardLift(Number.NaN, 24)).toBe(0);
  expect(composerKeyboardLift(320, Number.NaN)).toBe(320);
});
