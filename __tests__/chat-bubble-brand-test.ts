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

function styleBlock(src: string, key: string): string {
  const keyAt = src.indexOf(`${key}: {`);
  if (keyAt < 0) throw new Error(`missing style block ${key}`);
  const closeAt = src.indexOf('},', keyAt);
  return src.slice(keyAt, closeAt + 2);
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

  test('the assistant reply is unboxed and the user bubble is soft grey', () => {
    // No card shell, no avatar monogram: the answer is text on the stage.
    expect(bubble).not.toMatch(/<Card\b/);
    expect(bubble).not.toContain('styles.monogram');
    // User fill is a neutral surface step — never the violet "selected" tint.
    expect(bubble).toContain('{ backgroundColor: tokens.backgroundRaised }');
    expect(bubble).not.toContain('tokens.accentMuted');
    expect(bubble).not.toMatch(/borderColor: tokens\.accent\b/);
  });

  test('no bubble state leans on a border: the shell style blocks are borderless', () => {
    for (const key of ['bubble', 'userBubble', 'assistantBubble']) {
      expect(styleBlock(bubble, key)).not.toMatch(/border(?:Width|Color)/);
    }
    // Interrupted / streaming / failed turns keep their own signals (badges,
    // the caret, the retry action) instead of a hairline colour change.
    expect(bubble).not.toMatch(/borderColor: tokens\.(accent|statusDisconnected)/);
    expect(bubble).toContain('<StreamingIndicator />');
    expect(bubble).toContain("commandStatus === 'running'");
    expect(bubble).toContain('label="Interrupted"');
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
