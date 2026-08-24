/**
 * Contract pins for the SwiftUI-backed kit TextField. Rook's 2026-08-24
 * review found the iOS field silently dropping autoCapitalize/autoCorrect/
 * secureTextEntry — token fields on the wedge path (gateway add, provider
 * key sheet) were left to iOS autocorrect's mercy while the shared prop type
 * promised otherwise. These pins hold both halves of that fix:
 *   1. the pure translation helpers in src/components/ui/text-field-ios.ts,
 *   2. the live TextField.ios.tsx wiring itself, scanned off disk so a revert
 *      of the modifiers while keeping the helpers still fails here.
 *
 * The scan logic stays a pure helper over {path, content} pairs; node
 * built-ins come through jest.requireActual because the project ships
 * without @types/node (see raw-text-input-retirement-test).
 */
declare const __dirname: string;

import {
  autocapitalizationFor,
  autocorrectionDisabledFor,
  submitLabelFor,
  usesSecureField,
} from '@/components/ui/text-field-ios';

const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

describe('iOS kit TextField keyboard translations', () => {
  describe('autocapitalizationFor', () => {
    test('maps every RN autoCapitalize value onto SwiftUI vocabulary', () => {
      expect(autocapitalizationFor('none')).toBe('never');
      expect(autocapitalizationFor('sentences')).toBe('sentences');
      expect(autocapitalizationFor('words')).toBe('words');
      expect(autocapitalizationFor('characters')).toBe('characters');
    });

    test('an omitted prop pins never — the kit default for secret fields', () => {
      expect(autocapitalizationFor(undefined)).toBe('never');
    });
  });

  describe('autocorrectionDisabledFor', () => {
    test('off by default and inverted from RN polarity', () => {
      expect(autocorrectionDisabledFor(undefined)).toBe(true);
      expect(autocorrectionDisabledFor(false)).toBe(true);
      expect(autocorrectionDisabledFor(true)).toBe(false);
    });
  });

  describe('submitLabelFor', () => {
    test('every shared returnKeyType has an exact SwiftUI submitLabel', () => {
      expect(submitLabelFor('done')).toBe('done');
      expect(submitLabelFor('go')).toBe('go');
      expect(submitLabelFor('next')).toBe('next');
      expect(submitLabelFor('search')).toBe('search');
      expect(submitLabelFor('send')).toBe('send');
    });
  });

  describe('usesSecureField', () => {
    test('secure wins over multiline, mirroring RN forbidding the combo', () => {
      expect(usesSecureField(undefined)).toBe(false);
      expect(usesSecureField(false)).toBe(false);
      expect(usesSecureField(true)).toBe(true);
    });
  });
});

/** Wiring fragments whose presence proves the .ios component forwards each prop. */
const REQUIRED_WIRING = [
  'textInputAutocapitalization(autocapitalizationFor(autoCapitalize))',
  'autocorrectionDisabled(autocorrectionDisabledFor(autoCorrect))',
  'submitLabel(submitLabelFor(returnKeyType))',
  'disabled(true)',
  'onSubmit(onSubmitEditing)',
  '<SecureField',
];

export function missingIosWiring(source: string): string[] {
  return REQUIRED_WIRING.filter((fragment) => !source.includes(fragment));
}

describe('the live iOS field keeps forwarding what the helpers translate', () => {
  const SEP = __dirname.includes('\\') ? '\\' : '/';
  const source = nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'ui', 'TextField.ios.tsx'].join(SEP),
    'utf8',
  );

  test('TextField.ios.tsx wires every translated modifier onto the native field', () => {
    expect(missingIosWiring(source)).toEqual([]);
  });

  test('the platform-contract comment no longer claims keyboard flags are ignored', () => {
    expect(source).not.toMatch(/no native events or modifiers wired/);
    expect(source).toMatch(/onKeyPress/); // the one honestly-unsupported prop stays documented
  });
});
