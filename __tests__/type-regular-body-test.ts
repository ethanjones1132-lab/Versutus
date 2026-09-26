// tokens.ts only needs Easing for Motion curves; reanimated's native
// worklet unpackers cannot load under jest-expo.
jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
}));

import { FontFamily, Typography } from '@/constants/tokens';

/**
 * S7a (`docs/visual-direction-2026-09.md` type lock): reading text is Regular
 * (400) and chrome keeps Medium+; large headings track tighter. Before this,
 * only 500/600/700 were loaded, so every paragraph in the app rendered at
 * Medium — the "everything looks heavy" half of why the transcript did not
 * read like a peer. These assertions are the contract that keeps a later
 * "tidy the font map" pass from silently re-fattening the body copy.
 */

const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};
const SEP = __dirname.includes('\\') ? '\\' : '/';

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('Regular 400 body type is loaded and applied', () => {
  test('the 400 face ships in the font gate', () => {
    const src = readSource('src', 'components', 'font-provider.tsx');
    expect(src).toContain('InstrumentSans_400Regular');
    // Loaded through the same useFonts map as the rest of the family, so the
    // body face is never a fallback system font.
    const map = src.slice(src.indexOf('useFonts({'), src.indexOf('});', src.indexOf('useFonts({')));
    expect(map).toContain('InstrumentSans_400Regular');
    expect(map).toContain('InstrumentSans_500Medium');
    expect(map).toContain('InstrumentSans_600SemiBold');
  });

  test('the family map gained Regular instead of renaming its keys', () => {
    expect(FontFamily.sansRegular).toBe('InstrumentSans_400Regular');
    expect(FontFamily.sans).toBe('InstrumentSans_500Medium');
    expect(FontFamily.sansSemiBold).toBe('InstrumentSans_600SemiBold');
    expect(FontFamily.sansBold).toBe('InstrumentSans_700Bold');
    expect(FontFamily.mono).toBe('JetBrainsMono_500Medium');
    expect(FontFamily.monoBold).toBe('JetBrainsMono_700Bold');
  });

  test('body reads at 400 while chrome variants keep Medium+', () => {
    expect(Typography.body.fontWeight).toBe('400');
    expect(Typography.caption.fontWeight).toBe('500');
    expect(Typography.micro.fontWeight).toBe('500');
    expect(Typography.display.fontWeight).toBe('600');
    expect(Typography.title.fontWeight).toBe('600');
    expect(Typography.headline.fontWeight).toBe('600');
  });
});

describe('the shared Text default renders reading copy at Regular', () => {
  const textSource = readSource('src', 'components', 'ui', 'Text.tsx');

  test('the default (body) variant names the Regular family', () => {
    expect(textSource).toContain(
      'body: { ...Typography.body, fontFamily: FontFamily.sansRegular }'
    );
  });

  test('chrome variants stay on Medium and headings stay on SemiBold', () => {
    expect(textSource).toContain('caption: { ...Typography.caption, fontFamily: FontFamily.sans }');
    expect(textSource).toContain('micro: { ...Typography.micro, fontFamily: FontFamily.sans }');
    expect(textSource).toMatch(/display: \{ \.\.\.Typography\.display, fontFamily: FontFamily\.sansSemiBold \}/);
    expect(textSource).toMatch(/title: \{ \.\.\.Typography\.title, fontFamily: FontFamily\.sansSemiBold \}/);
    expect(textSource).toMatch(/headline: \{ \.\.\.Typography\.headline, fontFamily: FontFamily\.sansSemiBold \}/);
  });

  test('the link variant lifts to SemiBold instead of inheriting body 400', () => {
    // The one place a variant must override the scale's weight: link takes the
    // body metrics but names the SemiBold face, so the two have to be declared
    // together — a 400 declaration over the 600 face is how a platform ends up
    // synthesising a weight nobody chose.
    expect(textSource).toContain(
      "link: { ...Typography.body, fontWeight: '600', fontFamily: FontFamily.sansSemiBold }"
    );
    expect(textSource.match(/fontWeight/g)?.length).toBe(1);
    expect(Typography.body.fontWeight).toBe('400');
    expect(FontFamily.sansRegular).toContain('400');
  });
});

describe('the assistant reply — the hero reading surface — reads Regular', () => {
  const md = readSource('src', 'components', 'chat', 'markdown', 'markdown-text.tsx');

  test('paragraph, compact and quoted body copy use the Regular family', () => {
    expect(md).toMatch(/body: \{\n\s*fontFamily: FontFamily\.sansRegular,/);
    expect(md).toMatch(/bodyCompact: \{\n\s*fontFamily: FontFamily\.sansRegular,/);
    // Quotes render through `styles.body`, so they inherit Regular too.
    expect(md).toContain('compact ? styles.bodyCompact : styles.body');
    expect(md).not.toContain('fontFamily: FontFamily.sans,');
  });

  test('emphasised spans keep their own heavier faces', () => {
    expect(md).toContain('bold: {');
    expect(md).toContain('fontFamily: FontFamily.sansBold');
    expect(md).toContain('fontFamily: FontFamily.sansSemiBold');
  });

  test('large headings track tighter instead of loose at display sizes', () => {
    const sizes = md.match(/HEADING_SIZES[\s\S]*?\};/)?.[0] ?? '';
    expect(sizes).toBeDefined();
    expect(sizes).toMatch(/1: \{ fontSize: 22, lineHeight: 28, letterSpacing: -\d/);
    expect(sizes).toMatch(/2: \{ fontSize: 19, lineHeight: 25, letterSpacing: -\d/);
  });
});

describe('large heading tracking is tightened in the type scale', () => {
  test('display, title and headline no longer ship at zero tracking', () => {
    expect(Typography.display.letterSpacing).toBeLessThan(0);
    expect(Typography.title.letterSpacing).toBeLessThan(0);
    expect(Typography.headline.letterSpacing).toBeLessThan(0);
  });

  test('the tighter the heading, the tighter the tracking', () => {
    expect(Typography.display.letterSpacing).toBeLessThan(Typography.title.letterSpacing);
    expect(Typography.title.letterSpacing).toBeLessThan(Typography.headline.letterSpacing);
    expect(Typography.headline.letterSpacing).toBeLessThan(0);
  });

  test('reading and small chrome sizes keep their own tracking', () => {
    expect(Typography.body.letterSpacing).toBe(0);
    expect(Typography.caption.letterSpacing).toBe(0);
    expect(Typography.micro.letterSpacing).toBe(0.4);
  });
});

describe('typed text is reading text too', () => {
  test('the shared text field inputs Regular, not the chrome Medium', () => {
    const field = readSource('src', 'components', 'ui', 'TextField.tsx');
    expect(field).toContain('fontFamily: FontFamily.sansRegular');
    expect(field).not.toContain('fontFamily: FontFamily.sans,');
  });

  test('the composer rides that same field, so the pill types Regular', () => {
    const composer = readSource('src', 'components', 'chat', 'chat-composer.tsx');
    expect(composer).toContain('<TextField');
  });
});
