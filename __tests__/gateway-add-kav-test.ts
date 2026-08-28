import { gatewayAddKeyboardBehavior } from '@/lib/gateway/add-keyboard-behavior';

describe('gatewayAddKeyboardBehavior', () => {
  test('iOS uses padding (lifts ScrollView above IME)', () => {
    expect(gatewayAddKeyboardBehavior('ios')).toBe('padding');
  });

  test('Android uses undefined (ScrollView pans, no height squeeze)', () => {
    expect(gatewayAddKeyboardBehavior('android')).toBeUndefined();
  });

  test('web uses undefined (no KAV needed)', () => {
    expect(gatewayAddKeyboardBehavior('web')).toBeUndefined();
  });

  test('unknown platform defaults to undefined', () => {
    expect(gatewayAddKeyboardBehavior('windows')).toBeUndefined();
    expect(gatewayAddKeyboardBehavior('')).toBeUndefined();
  });
});
