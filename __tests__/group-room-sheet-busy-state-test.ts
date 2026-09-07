declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readSheet(): string {
  return readSource(['src', 'components', 'chat', 'group-room-action-sheet.tsx']);
}

function readButton(): string {
  return readSource(['src', 'components', 'ui', 'Button.tsx']);
}

// The group-room action sheet holds three real in-flight booleans that
// already swap each primary label and disable its button while the room
// call is in flight — but without a `busy` half a screen-reader user
// heard a flat disabled label while a sighted user saw the in-flight
// state. The fix is three one-line `busy={…Busy}` wirings onto the
// `busy` prop Button spreads defined-only into accessibilityState.
describe('group-room sheet busy state', () => {
  test('the Remove button passes busy={removingBusy}', () => {
    const src = readSheet();
    expect(src).toContain('busy={removingBusy}');
  });

  test('the Add button passes busy={addingBusy}', () => {
    const src = readSheet();
    expect(src).toContain('busy={addingBusy}');
  });

  test('the Rename button passes busy={renamingBusy}', () => {
    const src = readSheet();
    expect(src).toContain('busy={renamingBusy}');
  });

  test('each busy wiring lands exactly once', () => {
    const src = readSheet();
    expect(src.match(/busy=\{removingBusy\}/g)?.length ?? 0).toBe(1);
    expect(src.match(/busy=\{addingBusy\}/g)?.length ?? 0).toBe(1);
    expect(src.match(/busy=\{renamingBusy\}/g)?.length ?? 0).toBe(1);
  });

  test('the three label ternaries stay byte-identical', () => {
    const src = readSheet();
    expect(src).toContain("label={removingBusy ? 'Removing…' : 'Remove from room'}");
    expect(src).toContain("label={addingBusy ? 'Adding…' : 'Add to room'}");
    expect(src).toContain("label={renamingBusy ? 'Renaming…' : 'Rename'}");
  });

  test('the three disabled gates stay byte-identical', () => {
    const src = readSheet();
    expect(src).toContain('disabled={removingBusy || !removeSelection}');
    expect(src).toContain('disabled={addingBusy || addSelection.length === 0}');
    expect(src).toContain('disabled={renamingBusy || !renameDraft.trim()}');
  });

  test('the three Cancel buttons stay byte-identical with no busy', () => {
    const src = readSheet();
    expect(src).toContain('disabled={removingBusy}');
    expect(src).toContain('disabled={addingBusy}');
    expect(src).toContain('disabled={renamingBusy}');
    expect(src.match(/label="Cancel"/g)?.length ?? 0).toBe(3);
    expect(src).not.toContain('busy={disbanding}');
  });

  test('the member Chip selected wirings stay byte-identical', () => {
    const src = readSheet();
    expect(src).toContain('selected={removeSelection === option.id}');
    expect(src).toContain('selected={addSelection.includes(bot.id)}');
  });

  test('the rename TextField stays byte-identical', () => {
    const src = readSheet();
    expect(src).toContain('value={renameDraft}');
    expect(src).toContain('onChangeText={setRenameDraft}');
    expect(src).toContain('onSubmitEditing={submitRename}');
  });

  test('Button spreads a defined-only busy half', () => {
    const src = readButton();
    expect(src).toContain('...(busy !== undefined ? { busy } : null)');
  });
});
