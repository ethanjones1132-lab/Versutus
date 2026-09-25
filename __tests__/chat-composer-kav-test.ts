declare const __dirname: string;

import {
  CHAT_COMPOSER_KAV_BASE_ROW,
  chatComposerKeyboardOffset,
} from '@/lib/motion/chat-composer-layout';

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

describe('chatComposerKeyboardOffset', () => {
  test('Android returns 0 (KAV not used, lift via ComposerKeyboardLift)', () => {
    expect(chatComposerKeyboardOffset({ platform: 'android', topInset: 47 })).toBe(0);
    expect(chatComposerKeyboardOffset({ platform: 'android', topInset: 0 })).toBe(0);
  });

  test('web returns 0', () => {
    expect(chatComposerKeyboardOffset({ platform: 'web', topInset: 20 })).toBe(0);
  });

  test('iOS clears the header plus the status-bar inset', () => {
    expect(chatComposerKeyboardOffset({ platform: 'ios', topInset: 47 })).toBe(
      CHAT_COMPOSER_KAV_BASE_ROW + 47,
    );
    expect(chatComposerKeyboardOffset({ platform: 'ios', topInset: 0 })).toBe(
      CHAT_COMPOSER_KAV_BASE_ROW,
    );
  });

  test('the base is the single-row header height — there is no second row to clear', () => {
    expect(CHAT_COMPOSER_KAV_BASE_ROW).toBe(72);
    // The header is one row (back · title · one menu), so the offset grew no
    // width branch: nothing can push the composer down a wrapped chip row.
    const src = nodeFs
      .readFileSync([__dirname, '..', 'src', 'lib', 'motion', 'chat-composer-layout.ts'].join(SEP), 'utf8')
      .replace(/\r\n/g, '\n');
    expect(src).not.toContain('CHAT_COMPOSER_KAV_BASE_STACKED');
    expect(src).not.toContain('chatHeaderChipLayout');
  });

  test('non-finite or negative inset is treated as 0', () => {
    expect(chatComposerKeyboardOffset({ platform: 'ios', topInset: NaN })).toBe(
      CHAT_COMPOSER_KAV_BASE_ROW,
    );
    expect(chatComposerKeyboardOffset({ platform: 'ios', topInset: -10 })).toBe(
      CHAT_COMPOSER_KAV_BASE_ROW,
    );
  });
});
