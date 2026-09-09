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

function readOverflowSheet(): string {
  return readSource(['src', 'components', 'chat', 'chat-overflow-sheet.tsx']);
}

// The overflow "Disconnect gateway" row used to fire onDisconnect() and
// onClose() in the same tap, dropping the connection with no confirmation —
// unlike session delete, group disband, and provider remove, which all arm a
// danger ConfirmSheet first. Arm one here and call onDisconnect only on
// confirm.
function extractRow(src: string, title: string): string {
  const titleIdx = src.indexOf(`title="${title}"`);
  expect(titleIdx).toBeGreaterThan(-1);
  const start = src.lastIndexOf('<ListRow', titleIdx);
  const end = src.indexOf('/>', titleIdx);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(-1);
  return src.slice(start, end + 2);
}

function extractConfirmSheet(src: string): string {
  const start = src.indexOf('<ConfirmSheet');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('/>', start);
  expect(end).toBeGreaterThan(-1);
  return src.slice(start, end + 2);
}

describe('Chat overflow Disconnect gateway confirmation', () => {
  test('the Disconnect row arms the confirmation instead of disconnecting', () => {
    const row = extractRow(readOverflowSheet(), 'Disconnect gateway');
    expect(row).toContain('setDisconnectArmed(true)');
    expect(row).not.toContain('onDisconnect()');
  });

  test('the confirmation is a danger sheet naming the disconnect', () => {
    const confirm = extractConfirmSheet(readOverflowSheet());
    expect(confirm).toContain('danger');
    expect(confirm).toContain('confirmLabel="Disconnect gateway"');
    expect(confirm).toContain('title="Disconnect gateway?"');
    expect(confirm).toContain('setDisconnectArmed(false)');
  });

  test('confirm fires onDisconnect then closes; cancel only disarms', () => {
    const confirm = extractConfirmSheet(readOverflowSheet());
    expect(confirm).toMatch(
      /onConfirm=\{\(\) => \{\s*setDisconnectArmed\(false\);\s*onDisconnect\(\);\s*onClose\(\);/,
    );
    expect(confirm).toContain('onCancel={() => setDisconnectArmed(false)}');
  });

  test('sibling rows still fire their handler and close, with no confirm of their own', () => {
    const src = readOverflowSheet();
    const siblings: Array<{ title: string; handler: string }> = [
      { title: 'Edit agent', handler: 'onEditAgent();' },
      { title: 'Run task', handler: 'onStartRun();' },
      { title: 'Reload history', handler: 'onReloadHistory();' },
      { title: 'New session', handler: 'onNewSession();' },
    ];
    for (const { title, handler } of siblings) {
      const row = extractRow(src, title);
      expect(row).toContain(handler);
      expect(row).toContain('onClose();');
      expect(row).not.toContain('setDisconnectArmed');
    }
    // Exactly one ConfirmSheet mounts in the overflow sheet.
    expect(src.match(/<ConfirmSheet/g)?.length).toBe(1);
  });

  test('ConfirmSheet renders a Cancel plus the labelled confirm action', () => {
    const src = readSource(['src', 'components', 'ui', 'ConfirmSheet.tsx']);
    expect(src).toContain('danger?: boolean;');
    expect(src).toContain('onCancel: () => void;');
    expect(src).toContain('onConfirm: () => void;');
    expect(src).toContain('<Button label="Cancel"');
    expect(src).toContain('label={confirmLabel}');
  });

  test('chat-screen still wires onDisconnect straight to disconnectGateway', () => {
    const src = readSource(['src', 'components', 'chat', 'chat-screen.tsx']);
    expect(src).toContain('onDisconnect={disconnectGateway}');
  });
});
