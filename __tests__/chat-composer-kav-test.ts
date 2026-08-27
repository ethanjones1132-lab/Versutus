import {
  CHAT_COMPOSER_KAV_BASE_ROW,
  CHAT_COMPOSER_KAV_BASE_STACKED,
  chatComposerKeyboardOffset,
} from '@/lib/motion/chat-composer-layout';

describe('chatComposerKeyboardOffset', () => {
  test('Android returns 0 regardless of width (KAV not used, lift via ComposerKeyboardLift)', () => {
    expect(
      chatComposerKeyboardOffset({ platform: 'android', windowWidth: 360, topInset: 47 }),
    ).toBe(0);
    expect(
      chatComposerKeyboardOffset({ platform: 'android', windowWidth: 390, topInset: 0 }),
    ).toBe(0);
  });

  test('web returns 0', () => {
    expect(chatComposerKeyboardOffset({ platform: 'web', windowWidth: 360, topInset: 20 })).toBe(0);
  });

  test('iOS narrow phone with both chips stacked uses stacked base + inset', () => {
    // 360dp + 2 chips is the stacked case from chat-header-layout.ts:38
    const offset = chatComposerKeyboardOffset({
      platform: 'ios',
      windowWidth: 360,
      topInset: 47,
      hasModelChip: true,
      hasSessionChip: true,
    });
    expect(offset).toBe(CHAT_COMPOSER_KAV_BASE_STACKED + 47);
    expect(offset).toBeGreaterThanOrEqual(CHAT_COMPOSER_KAV_BASE_STACKED);
  });

  test('iOS narrow phone offset is at least stacked header height (covers 24px delta)', () => {
    const offsetStacked = chatComposerKeyboardOffset({
      platform: 'ios',
      windowWidth: 360,
      topInset: 0,
      hasModelChip: true,
      hasSessionChip: true,
    });
    expect(offsetStacked).toBe(CHAT_COMPOSER_KAV_BASE_STACKED);
    expect(offsetStacked - CHAT_COMPOSER_KAV_BASE_ROW).toBe(24);
  });

  test('iOS wide phone with row layout uses row base + inset', () => {
    const offset = chatComposerKeyboardOffset({
      platform: 'ios',
      windowWidth: 600,
      topInset: 47,
      hasModelChip: true,
      hasSessionChip: true,
    });
    expect(offset).toBe(CHAT_COMPOSER_KAV_BASE_ROW + 47);
  });

  test('iOS with no chips uses row base (nothing to stack)', () => {
    const offset = chatComposerKeyboardOffset({
      platform: 'ios',
      windowWidth: 360,
      topInset: 20,
      hasModelChip: false,
      hasSessionChip: false,
    });
    expect(offset).toBe(CHAT_COMPOSER_KAV_BASE_ROW + 20);
  });

  test('defaults to stacked-safe (both chips assumed) when not specified', () => {
    const offset = chatComposerKeyboardOffset({ platform: 'ios', windowWidth: 360, topInset: 0 });
    expect(offset).toBe(CHAT_COMPOSER_KAV_BASE_STACKED);
  });

  test('non-finite or negative inset is treated as 0', () => {
    expect(
      chatComposerKeyboardOffset({ platform: 'ios', windowWidth: 600, topInset: NaN }),
    ).toBe(CHAT_COMPOSER_KAV_BASE_ROW);
    expect(
      chatComposerKeyboardOffset({ platform: 'ios', windowWidth: 600, topInset: -10 }),
    ).toBe(CHAT_COMPOSER_KAV_BASE_ROW);
  });
});
