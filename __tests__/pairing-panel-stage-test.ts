jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
}));

declare const __dirname: string;

import { Palette } from '@/constants/tokens';

const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};
const SEP = __dirname.includes('\\') ? '\\' : '/';

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

const pairing = () => readSource('src', 'components', 'pairing-panel.tsx');

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

// CHARTER priority 1 / docs/visual-direction-2026-09.md: the approve-this-phone
// panel still wore the brighter focus violet as its doubled hairline and step
// numerals, so the pairing step read warmer than the connect flow it serves.
describe('the pairing panel reads brand violet on the cool stage', () => {
  it('draws its panel border from the brand, not the focus tint', () => {
    const src = pairing();
    expect(src).toContain('borderColor: tokens.accent,');
    expect(src).toContain('borderWidth: StyleSheet.hairlineWidth * 2');
    expect(src).not.toContain('accentWarm');
  });

  it('paints all three step numerals brand violet', () => {
    const src = pairing();
    expect(occurrences(src, '<Text variant="caption" color="accent">')).toBe(3);
    expect(src).not.toMatch(/accentWarm|accentWarmMuted/);
  });

  it('keeps brand violet violet and off gold-as-brand', () => {
    expect(Palette.accent).toBe('#8B7CFF');
    expect(Palette.accent).not.toBe(Palette.accentWarm);
    expect(Palette.accent).not.toBe(Palette.gold);
    const src = pairing();
    expect(src).not.toMatch(/Palette\.gold|tokens\.gold/);
  });
});

describe('the pairing panel keeps its copy and pairing behaviour', () => {
  it('still offers the list / approve / device-id copy rows with feedback', () => {
    const src = pairing();
    for (const needle of [
      'openclaw devices list',
      'openclaw devices approve ',
      '<DeviceIdRow deviceId={deviceId} copied={copied} onCopy={copyText} />',
      "color={copied === kind ? 'accent' : 'tertiary'}",
      "copied === kind ? 'Copied' : 'Copy'",
      'await Clipboard.setStringAsync(text);',
    ]) {
      expect(src).toContain(needle);
    }
  });

  it('still carries the headline, remediation hint and auto-resume copy', () => {
    const src = pairing();
    for (const needle of [
      'Approve this phone on your PC',
      '{pairingDetails?.remediationHint ? (',
      'Connection will resume automatically after approval.',
      'Use the request id shown by the list command.',
    ]) {
      expect(src).toContain(needle);
    }
  });
});
