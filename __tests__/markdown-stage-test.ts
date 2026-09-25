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

describe('agent markdown and tool-call chrome read as the brand stage', () => {
  const markdown = readSource('src', 'components', 'chat', 'markdown', 'markdown-text.tsx');
  const toolCall = readSource('src', 'components', 'chat', 'tool-call-card.tsx');

  test('quotes, list markers, inline code and links wear the brand violet', () => {
    expect(markdown).toContain('borderLeftColor: Palette.accentMuted');
    expect(markdown).toContain('styles.listMarker, { color: Palette.accent }');
    expect(markdown).toContain('backgroundColor: Palette.backgroundInset,\n    color: Palette.accent,');
    expect(markdown).toContain('link: {\n    color: Palette.accent,');
  });

  test('the transcript renderer carries no focus-tint or gold chrome', () => {
    expect(markdown).not.toMatch(/accentWarm|accentWarmMuted/);
    expect(toolCall).not.toMatch(/accentWarm|accentWarmMuted/);
    expect(markdown).not.toContain('Palette.gold');
    expect(toolCall).not.toContain('Palette.gold');
  });

  test('markdown parsing, streaming guard, links and code blocks stay intact', () => {
    expect(markdown).toContain('markdownBlocksForDisplay(text, streaming)');
    expect(markdown).toContain('streaming = false');
    expect(markdown).toContain("WebBrowser.openBrowserAsync(url)");
    expect(markdown).toContain("accessibilityRole={span.link ? 'link' : undefined}");
    expect(markdown).toContain('<CodeBlock code={block.code} language={block.language} />');
    expect(markdown).toContain('maxFontSizeMultiplier ?? (compact ? 1.4 : undefined)');
    expect(markdown).toContain('textDecorationLine: \'underline\'');
  });

  test('the tool-call wrench is brand violet with status badges untouched', () => {
    expect(toolCall).toContain('color="accent"');
    expect(toolCall).toContain('variant="inset"');
    expect(toolCall).toContain('tone={STATUS_TONE[status]}');
    expect(toolCall).toContain("running: 'warning'");
    expect(toolCall).toContain("complete: 'success'");
    expect(toolCall).toContain("error: 'danger'");
    expect(toolCall).toContain('setDetailUserOverride');
    expect(toolCall).toContain('accessibilityState={{ expanded: isDetailExpanded }}');
  });

  test('the brand accent is violet, never gold', () => {
    const [red, green, blue] = hex(Palette.accent);
    expect(red).toBeGreaterThan(green);
    expect(blue).toBeGreaterThan(green);
    expect(Palette.accent).not.toBe(Palette.gold);
  });
});
