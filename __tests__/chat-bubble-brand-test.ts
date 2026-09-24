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

function hex(value: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) throw new Error(`expected 6-digit hex, got ${value}`);
  const number = parseInt(match[1], 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

describe('message bubbles and streaming presence use the brand stage', () => {
  const bubble = readSource('src', 'components', 'chat', 'message-bubble.tsx');
  const streaming = readSource('src', 'components', 'chat', 'streaming-indicator.tsx');

  test('the assistant monogram and user edge wear the brand violet', () => {
    expect(bubble).toContain('<Text variant="micro" color="accent" style={styles.monogramLetter}>');
    expect(bubble).toContain('{ backgroundColor: tokens.accentMuted, borderColor: tokens.accent }');
    expect(bubble).not.toMatch(/accentWarm|accentWarmMuted/);
  });

  test('live bubble borders use the muted brand pair without changing state branches', () => {
    expect(bubble).toContain("? { borderColor: tokens.accentMuted }");
    expect(bubble).toContain("? { borderColor: tokens.statusDisconnected }");
    expect(bubble).toContain("commandStatus === 'running'");
    expect(bubble).toContain('<StreamingIndicator />');
  });

  test('streaming dots are brand violet and keep the repeating presence motion', () => {
    expect(streaming).toContain('backgroundColor: tokens.accent');
    expect(streaming).not.toContain('backgroundColor: tokens.textSecondary');
    expect(streaming).toContain('withRepeat(');
    expect(streaming).toContain('withSequence(');
    expect(streaming).toMatch(/withRepeat\([\s\S]*?-1[\s\S]*?\)/);
  });

  test('the brand accent is violet, never gold', () => {
    const [red, green, blue] = hex(Palette.accent);
    expect(red).toBeGreaterThan(green);
    expect(blue).toBeGreaterThan(green);
    expect(Palette.accent).not.toBe(Palette.gold);
  });
});
