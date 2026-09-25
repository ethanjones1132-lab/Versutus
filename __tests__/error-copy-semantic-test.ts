jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
}));

import { Palette } from '@/constants/tokens';

declare const __dirname: string;

const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};
const SEP = __dirname.includes('\\') ? '\\' : '/';

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

const CHAT = ['src', 'components', 'chat'] as const;

const brandErrorCopy = /color="accent(?:Warm)?"[^>]*style={styles\.(?:error|sheetError)}/;

const errorCopySites = [
  {
    label: 'group room composer + sheet errors',
    source: readSource(...CHAT, 'group-room-view.tsx'),
    red: [
      { needle: 'color="statusDisconnected" style={styles.error}', count: 1 },
      { needle: 'color="statusDisconnected" style={styles.sheetError}', count: 2 },
    ],
    keep: [
      'color="accentWarm" style={styles.scopeNote}',
      '{error ? (',
      'style={styles.sheetError}',
    ],
  },
  {
    label: 'create group sheet error',
    source: readSource(...CHAT, 'create-group-sheet.tsx'),
    red: [{ needle: 'color="statusDisconnected" style={styles.error}', count: 1 }],
    keep: ['onCreate({ name: name.trim(), memberIds })', 'disabled={busy || !validation.ok}'],
  },
  {
    label: 'group room action sheet errors',
    source: readSource(...CHAT, 'group-room-action-sheet.tsx'),
    red: [{ needle: 'color="statusDisconnected" style={styles.sheetError}', count: 4 }],
    keep: ['describeRoomError', 'onRename', 'onDisband', 'color="accent"'],
  },
  {
    label: 'bot detail soul failure note',
    source: readSource(...CHAT, 'bot-detail-sheet.tsx'),
    red: [
      {
        needle: "color={soulState.failed ? 'statusDisconnected' : 'tertiary'}",
        count: 1,
      },
    ],
    keep: ['soulState.failed && onRetry', 'onPress={onRetry}'],
  },
] as const;

describe('error copy reads semantic red, not the brand violet', () => {
  it.each(errorCopySites)('$label paints failures with statusDisconnected', ({ source, red }) => {
    for (const site of red) {
      expect(source.split(site.needle).length - 1).toBe(site.count);
    }
    expect(source).not.toMatch(brandErrorCopy);
  });

  it('bot detail failure branch never falls back to the brand accent', () => {
    const source = readSource(...CHAT, 'bot-detail-sheet.tsx');
    expect(source).not.toContain("soulState.failed ? 'accent'");
  });

  it('statusDisconnected is a red distinct from the violet brand', () => {
    const [red, green, blue] = (Palette.statusDisconnected.match(/[0-9a-f]{2}/gi) ?? []).map(
      (part) => parseInt(part, 16),
    );
    expect(red).toBeGreaterThan(green);
    expect(red).toBeGreaterThan(blue);
    expect(Palette.statusDisconnected).not.toBe(Palette.accent);
    expect(Palette.statusDisconnected).not.toBe(Palette.accentWarm);
  });
});

describe('error-copy sweep keeps behaviour and scope boundaries', () => {
  it.each(errorCopySites)('$label keeps its error guards and actions', ({ source, keep }) => {
    for (const needle of keep) {
      expect(source).toContain(needle);
    }
  });

  it('leaves the separate group-room chrome accents for the group-room item', () => {
    const source = readSource(...CHAT, 'group-room-view.tsx');
    expect(source.match(/color="accentWarm"/g) ?? []).toHaveLength(3);
    expect(source).toContain('tintColor={tokens.accentWarm}');
  });

  it('leaves informational non-error captions on brand violet', () => {
    const actionSheet = readSource(...CHAT, 'group-room-action-sheet.tsx');
    expect(actionSheet).toContain('<Text variant="caption" color="accent">');
    expect(actionSheet).toContain('not on this gateway');

    const botDetail = readSource(...CHAT, 'bot-detail-sheet.tsx');
    expect(botDetail).toContain('<Text variant="caption" color="accent">');
    expect(botDetail).toContain('{exportNotice}');
  });
});
