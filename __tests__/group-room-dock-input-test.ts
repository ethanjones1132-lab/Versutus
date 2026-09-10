declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readDockInputBody(): string {
  const src = nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'chat', 'group-room-view.tsx'].join(SEP),
    'utf8',
  );
  const m = src.match(/dockInput:\s*\{([^}]+)\}/);
  if (!m) throw new Error('dockInput style not found in group-room-view.tsx');
  return m[1];
}

function readGroupRoomViewSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'chat', 'group-room-view.tsx'].join(SEP),
    'utf8',
  );
}

test('group room dock input meets 48dp touch target', () => {
  const body = readDockInputBody();
  const minHeightMatch = body.match(/minHeight:\s*(\d+)/);
  expect(minHeightMatch).not.toBeNull();
  const minHeight = Number(minHeightMatch![1]);
  expect(minHeight).toBeGreaterThanOrEqual(48);
  expect(body).not.toMatch(/minHeight:\s*0\b/);
});

test('group room dock input keeps flex 1', () => {
  const body = readDockInputBody();
  expect(body).toMatch(/flex:\s*1\b/);
});

test('the dock input is the field the shared-text handoff takes the cursor to', () => {
  // Parity with a Bot Chat: a shared text that lands in a room opens the field
  // it landed in, so the room hands its DOCK field the handle the screen
  // focuses. The rename field in the room's sheet takes none — no shared text
  // lands there, and the screen decides when a cursor moves at all.
  const src = readGroupRoomViewSource();
  const dock = src.slice(src.indexOf('<TextField'), src.indexOf('style={styles.dockInput}'));
  expect(dock).toContain('inputRef={inputRef}');

  const renameAt = src.indexOf('value={renameDraft}');
  const rename = src.slice(renameAt, src.indexOf('/>', renameAt));
  expect(rename).not.toContain('inputRef={inputRef}');
});
