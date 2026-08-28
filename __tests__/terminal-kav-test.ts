import { composerKeyboardLift } from '@/lib/motion/keyboard-lift';
import { isTerminalKavEnabled, terminalKeyboardBehavior } from '@/lib/terminal/keyboard-behavior';

describe('terminalKeyboardBehavior', () => {
  test('iOS uses padding (KAV lifts, Android lift is via ComposerKeyboardLift)', () => {
    expect(terminalKeyboardBehavior('ios')).toBe('padding');
    expect(isTerminalKavEnabled('ios')).toBe(true);
  });

  test('Android bypasses KAV (ComposerKeyboardLift owns lift)', () => {
    expect(terminalKeyboardBehavior('android')).toBeUndefined();
    expect(isTerminalKavEnabled('android')).toBe(false);
  });

  test('web bypasses KAV', () => {
    expect(terminalKeyboardBehavior('web')).toBeUndefined();
    expect(isTerminalKavEnabled('web')).toBe(false);
  });

  test('unknown platform bypasses KAV', () => {
    expect(terminalKeyboardBehavior('windows')).toBeUndefined();
    expect(terminalKeyboardBehavior('')).toBeUndefined();
  });
});

describe('terminal ComposerKeyboardLift on Android', () => {
  test('IME lifts by keyboard minus bottom inset (same as chat)', () => {
    expect(composerKeyboardLift(300, 42)).toBe(258);
    expect(composerKeyboardLift(300, 0)).toBe(300);
  });

  test('closed keyboard keeps bottom inset (dock above nav bar)', () => {
    expect(composerKeyboardLift(0, 42)).toBe(42);
    expect(composerKeyboardLift(16, 42)).toBe(0);
    expect(composerKeyboardLift(NaN, 42)).toBe(42);
  });

  test('terminal input wrapper lifts history chips and send card together', () => {
    // The terminal ComposerKeyboardLift is the outer wrapper for both the
    // 3-chip history row and the input Card; the lift value is identical to
    // chat's composer — verify the arithmetic the wrapper relies on.
    const liftWithHistory = composerKeyboardLift(320, 48);
    expect(liftWithHistory).toBe(272);
    expect(liftWithHistory).toBeGreaterThan(0);
  });
});
