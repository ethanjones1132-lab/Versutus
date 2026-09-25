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

const room = readSource('src', 'components', 'chat', 'group-room-view.tsx');

describe('group room chrome reads as the brand stage', () => {
  test('pull-to-refresh, the room scope note and member pins wear brand violet', () => {
    expect(room).toContain('tintColor={tokens.accent}');
    expect(room).toContain('colors={[tokens.accent]}');
    expect(room).toContain('color="accent" style={styles.scopeNote}');
    expect(room.match(/color="accent" numberOfLines=\{1\}/g) ?? []).toHaveLength(2);
    expect(room).toContain('{routingTag}');
    expect(room).toContain('Not on gateway');
  });

  test('no focus-tint or gold chrome survives in the room', () => {
    expect(room).not.toMatch(/accentWarm|accentWarmMuted/);
    expect(room).not.toContain('Palette.gold');
  });

  test('failure copy stays semantic red while the pins stay informational', () => {
    expect(room.split('color="statusDisconnected" style={styles.error}').length - 1).toBe(1);
    expect(room.split('color="statusDisconnected" style={styles.sheetError}').length - 1).toBe(2);
    expect(room).not.toMatch(/color="accent[^"]*"[^>]*style={styles\.(?:error|sheetError)}/);
    expect(room).not.toMatch(/color="statusDisconnected"[^>]*style={styles\.scopeNote}/);
    expect(room).toContain('@mentions scope the round to');
  });

  test('refresh, mention routing, member removal and sheet flows stay wired', () => {
    expect(room).toContain('onRefresh={handleRefresh}');
    expect(room).toContain('onPress={handleRefresh}');
    expect(room).toContain('insertMention(draft, draft.length, memberId)');
    expect(room).toContain('mentionPicksAtCaret(draft, draft.length, group.memberIds)');
    expect(room).toContain('onLeave(memberId)');
    expect(room).toContain('setRenameVisible(true)');
    expect(room).toContain('setAddVisible(true)');
    expect(room).toContain('setDisbandVisible(true)');
    expect(room).toContain('describeRoomError(cause)');
    expect(room.match(/tokens\.glassHighlight/g) ?? []).toHaveLength(2);
    expect(room).toContain('styles.memberChip');
  });

  test('the brand accent is soft electric violet, never gold or status red', () => {
    const [red, green, blue] = hex(Palette.accent);
    expect(blue).toBeGreaterThan(green);
    expect(red).toBeGreaterThan(green);
    expect(Palette.accent).not.toBe(Palette.gold);
    expect(Palette.accent).not.toBe(Palette.statusDisconnected);
  });
});
