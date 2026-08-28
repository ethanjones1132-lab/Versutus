import { activityKeyboardBehavior, isActivityKavEnabled } from '@/lib/activity/keyboard-behavior';
import { composerKeyboardLift } from '@/lib/motion/keyboard-lift';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

describe('activityKeyboardBehavior', () => {
  test('iOS uses padding (KAV lifts, Android lift is via ComposerKeyboardLift)', () => {
    expect(activityKeyboardBehavior('ios')).toBe('padding');
    expect(isActivityKavEnabled('ios')).toBe(true);
  });

  test('Android bypasses KAV (ComposerKeyboardLift owns lift)', () => {
    expect(activityKeyboardBehavior('android')).toBeUndefined();
    expect(isActivityKavEnabled('android')).toBe(false);
  });

  test('web bypasses KAV', () => {
    expect(activityKeyboardBehavior('web')).toBeUndefined();
    expect(isActivityKavEnabled('web')).toBe(false);
  });

  test('unknown platform bypasses KAV', () => {
    expect(activityKeyboardBehavior('windows')).toBeUndefined();
    expect(activityKeyboardBehavior('')).toBeUndefined();
  });
});

describe('Activity ComposerKeyboardLift on Android', () => {
  test('IME lifts by keyboard minus bottom inset (same as chat/terminal)', () => {
    expect(composerKeyboardLift(300, 42)).toBe(258);
    expect(composerKeyboardLift(300, 0)).toBe(300);
  });

  test('closed keyboard or inset-covering IME yields no lift', () => {
    expect(composerKeyboardLift(0, 42)).toBe(0);
    expect(composerKeyboardLift(16, 42)).toBe(0);
    expect(composerKeyboardLift(NaN, 42)).toBe(0);
  });
});

describe('activity prompt IME lift wiring', () => {
  test('activity screen wraps start card with ComposerKeyboardLift and keeps handled taps', () => {
    const file = nodeFs.readFileSync(
      [__dirname, '..', 'src', 'app', '(tabs)', 'activity.tsx'].join(SEP),
      'utf8',
    );
    expect(file).toContain('ComposerKeyboardLift');
    expect(file).toContain('activityKeyboardBehavior');
    expect(file).toContain('keyboardShouldPersistTaps="handled"');
    expect(file).toContain('KeyboardAvoidingView');
  });
});