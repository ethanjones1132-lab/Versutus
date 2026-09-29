import { BOT_CREST_TONES } from '@/lib/bot-avatar';
import {
  ORB_BODY_STOPS,
  ORB_GLYPH_MIN_CONTRAST,
  hexAlpha,
  mixHex,
  orbGlyphContrast,
  orbGlyphIsDark,
} from '@/lib/stage/composer-light';
import { BRAND_TONE } from '@/lib/stage/lamp';

declare const __dirname: string;

const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};
const SEP = __dirname.includes('\\') ? '\\' : '/';

function readChat(file: string): string {
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'components', 'chat', file].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('the composer light, as data', () => {
  test('hexAlpha writes the tone at an alpha, clamped', () => {
    expect(hexAlpha('#5646D0', 0.5)).toBe('rgba(86, 70, 208, 0.5)');
    expect(hexAlpha('#FFFFFF', 2)).toBe('rgba(255, 255, 255, 1)');
    expect(hexAlpha('#000000', -1)).toBe('rgba(0, 0, 0, 0)');
  });

  test('mixHex runs from one stop to the other in sRGB', () => {
    expect(mixHex('#000000', '#FFFFFF', 0)).toBe('#000000');
    expect(mixHex('#000000', '#FFFFFF', 1)).toBe('#FFFFFF');
    expect(mixHex('#000000', '#FFFFFF', 0.5)).toBe('#808080');
    expect(mixHex(BRAND_TONE.from, BRAND_TONE.to, 1)).toBe(BRAND_TONE.to.toUpperCase());
  });

  test('the orb body is cut deep: light at the lip, the deep stop past the middle', () => {
    expect(ORB_BODY_STOPS[0]).toEqual({ offset: 0, toward: 0 });
    expect(ORB_BODY_STOPS[ORB_BODY_STOPS.length - 1]).toEqual({ offset: 1, toward: 1 });
    // Each stop runs further toward the deep colour than its offset alone
    // would carry it — the light is left to the sheen.
    for (const stop of ORB_BODY_STOPS) expect(stop.toward).toBeGreaterThanOrEqual(stop.offset);
  });

  test.each(BOT_CREST_TONES.map((tone, i) => [i, tone] as const))(
    'tone %i: the send glyph clears the 3:1 an icon needs',
    (_, tone) => {
      expect(orbGlyphContrast(tone)).toBeGreaterThanOrEqual(ORB_GLYPH_MIN_CONTRAST);
    },
  );

  test('the arrow is white on every jewel but the pale one', () => {
    const dark = BOT_CREST_TONES.filter((tone) => orbGlyphIsDark(tone));
    // Platinum's moonlight is too pale to hold a white arrow; every other
    // orb keeps the jewel's own white glyph.
    expect(dark).toEqual([{ from: '#E8E9EE', to: '#646878' }]);
    expect(orbGlyphIsDark(BRAND_TONE)).toBe(false);
  });
});

describe('the Lens contracts', () => {
  const lens = readChat('composer-lens.tsx');
  const composer = readChat('chat-composer.tsx');

  test('Reduce Motion stills every flourish but the focus light itself', () => {
    // Shimmer, breath, glint, bloom and ring all stand down; the rim still
    // lights on focus, because that is state, not decoration.
    expect(lens.match(/useReducedMotion\(\)/g) ?? []).toHaveLength(3);
    expect(lens).toContain('if (keystrokes === 0 || reduced) return;');
    expect(lens).toContain('if (listening && !reduced) {');
    expect(lens).toContain('if (sweeps === 0 || reduced) return;');
    expect(lens).toContain('entering={reduced ? undefined : orbBloom}');
    expect(lens).toContain('if (launches === 0 || reduced) return;');
  });

  test('the launch ring lives in the send slot, so it outlasts the orb turning to Stop', () => {
    const slot = composer.slice(
      composer.indexOf('style={styles.sendButton}'),
      composer.indexOf('</PressableScale>', composer.indexOf('style={styles.sendButton}')),
    );
    const ringAt = slot.indexOf('<LaunchRing tone={tone} launches={launches} />');
    expect(ringAt).toBeGreaterThan(-1);
    expect(ringAt).toBeLessThan(slot.indexOf('{isStreaming ? ('));
  });

  test('the room tone flows from the thread\'s Bot crest to the composer', () => {
    const screen = readChat('chat-screen.tsx');
    expect(screen).toContain("const composerTone = surface.kind === 'bot' ? threadCrest.tone : BRAND_TONE;");
    expect(screen).toContain('tone={composerTone}');
  });

  test('a send lets go a ring and a glint; only a growing draft shimmers', () => {
    expect(composer).toContain('setLaunches((n) => n + 1);\n    setSweeps((n) => n + 1);\n    onSend();');
    expect(composer).toContain('if (draft.length > lastDraftLength.current) setKeystrokes((n) => n + 1);');
  });
});
