declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readViewSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'chat', 'group-room-view.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('group-room sheet pills state', () => {
  test('the Rename pill binds expanded to renameVisible', () => {
    const src = readViewSource();
    const renameBlock = src.match(
      /accessibilityLabel="Rename room"[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(renameBlock).toBeDefined();
    expect(renameBlock!).toMatch(/accessibilityState=\{\{ expanded: renameVisible \}\}/);
    // The pill arms the rename sheet via setRenameVisible(true).
    expect(src).toMatch(/setRenameVisible\(true\)/);
  });

  test('the Add pill binds expanded to addVisible', () => {
    const src = readViewSource();
    const addBlock = src.match(
      /accessibilityLabel="Add members"[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(addBlock).toBeDefined();
    expect(addBlock!).toMatch(/accessibilityState=\{\{ expanded: addVisible \}\}/);
    // The pill arms the add sheet via setAddSelection([]) + setAddVisible(true).
    expect(src).toMatch(/setAddSelection\(\[\]\)[\s\S]*?setAddVisible\(true\)/);
  });

  test('both pill labels and roles stay byte-identical', () => {
    const src = readViewSource();
    expect(src).toMatch(/accessibilityLabel="Rename room"/);
    expect(src).toMatch(/accessibilityLabel="Add members"/);
    // Role directly precedes the label on both pills (role, then label,
    // then state) — pin the adjacency, not a block that starts mid-pill.
    expect(src).toMatch(/accessibilityRole="button"\s+accessibilityLabel="Rename room"/);
    expect(src).toMatch(/accessibilityRole="button"\s+accessibilityLabel="Add members"/);
  });

  test('the sheets stay driven by the same flags', () => {
    const src = readViewSource();
    expect(src).toMatch(/visible=\{renameVisible\}/);
    expect(src).toMatch(/visible=\{addVisible\}/);
  });

  test('the Disband pill stays the only accessibilityHint carrier', () => {
    const src = readViewSource();
    const hints = src.match(/accessibilityHint=/g) ?? [];
    expect(hints.length).toBe(1);
    expect(src).toMatch(/accessibilityLabel="Disband room"/);
  });

  test('the member-chip disabled state and plan-toggle expanded stay untouched', () => {
    const src = readViewSource();
    expect(src).toMatch(/accessibilityState=\{\{ disabled: !evictable \}\}/);
    expect(src).toMatch(/accessibilityState=\{\{ expanded: planExpanded \}\}/);
  });
});
