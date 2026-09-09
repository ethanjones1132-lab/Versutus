declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function readActionsSheet(): string {
  return readSource(['src', 'components', 'gateway', 'provider-actions-sheet.tsx']);
}

// The overflow "Disconnect" row used to fire onDisconnect() and onClose() in
// the same tap. The Gate's providers.auth.disconnect handler also vault.deletes
// the stored credential (gate/core/providers/rpc.mjs:85-91), so the tap
// destroyed the stored API key with no confirmation — unlike sibling Remove
// provider, which arms a danger ConfirmSheet first. Arm one here and call
// onDisconnect only on confirm.
function extractRow(src: string, title: string): string {
  const titleIdx = src.indexOf(`title="${title}"`);
  expect(titleIdx).toBeGreaterThan(-1);
  const start = src.lastIndexOf('<ListRow', titleIdx);
  const end = src.indexOf('/>', titleIdx);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(-1);
  return src.slice(start, end + 2);
}

function extractConfirmSheet(src: string, title: string): string {
  const titleIdx = src.indexOf(`title="${title}"`);
  expect(titleIdx).toBeGreaterThan(-1);
  const start = src.lastIndexOf('<ConfirmSheet', titleIdx);
  const end = src.indexOf('/>', titleIdx);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(-1);
  return src.slice(start, end + 2);
}

describe('Provider actions Disconnect confirmation', () => {
  test('the Disconnect row arms the confirmation instead of disconnecting', () => {
    const row = extractRow(readActionsSheet(), 'Disconnect');
    expect(row).toContain('setDisconnectVisible(true)');
    expect(row).not.toContain('onDisconnect');
  });

  test('the confirmation is a danger sheet naming the stored-credential removal', () => {
    const confirm = extractConfirmSheet(readActionsSheet(), 'Disconnect provider?');
    expect(confirm).toContain('danger');
    expect(confirm).toContain('confirmLabel="Disconnect"');
    expect(confirm).toMatch(/stored credential/);
    expect(confirm).toMatch(/removed from the Gate/);
  });

  test('confirm fires onDisconnect then closes; cancel only disarms', () => {
    const src = readActionsSheet();
    const confirm = extractConfirmSheet(src, 'Disconnect provider?');
    expect(confirm).toContain('onConfirm={executeDisconnect}');
    expect(confirm).toContain('onCancel={() => setDisconnectVisible(false)}');
    const body = src.match(
      /function executeDisconnect\(\) \{[\s\S]*?\n  \}/,
    )?.[0];
    expect(body).toBeDefined();
    expect(body).toMatch(/onDisconnect\(\);\s*setDisconnectVisible\(false\);\s*onClose\(\);/);
  });

  test('reversible sibling rows still fire their handler then close, with no confirm of their own', () => {
    const src = readActionsSheet();
    const siblings: Array<{ title: string; handler: string }> = [
      { title: 'Set key', handler: 'onSetKey' },
      { title: 'Authorize', handler: 'onAuthorize' },
      { title: 'Check readiness', handler: 'onCheck' },
      { title: 'Refresh catalog', handler: 'onRefresh' },
      { title: 'Disable', handler: 'onDisable' },
    ];
    for (const { title, handler } of siblings) {
      const row = extractRow(src, title);
      expect(row).toContain(`run(${handler})`);
      expect(row).not.toContain('setDisconnectVisible');
    }
  });

  test('Rename still opens the rename sheet with no confirm of its own', () => {
    const src = readActionsSheet();
    const row = extractRow(src, 'Rename');
    expect(row).toContain('openRename');
    expect(row).not.toContain('setDisconnectVisible');
  });

  test('the Remove provider ConfirmSheet stays byte-identical', () => {
    const confirm = extractConfirmSheet(readActionsSheet(), 'Remove provider?');
    expect(confirm).toContain('confirmLabel="Remove"');
    expect(confirm).toContain('danger');
    expect(confirm).toContain('`${label} and its stored credential will be removed from the Gate.`');
  });

  test('exactly the delete and disconnect ConfirmSheets mount', () => {
    const src = readActionsSheet();
    expect(src.match(/<ConfirmSheet/g)?.length).toBe(2);
  });

  test('providers-section still wires onDisconnect to the disconnect card action', () => {
    const src = readSource(['src', 'components', 'gateway', 'providers-section.tsx']);
    expect(src).toContain("onDisconnect={() => void runCardAction(snapshot.id, 'disconnect')}");
  });
});
