declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readPaneSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'gateway', 'paired-devices-pane.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('paired-devices retry', () => {
  test('the failed first read offers a Retry action wired to the load handler', () => {
    // A failed first read left the operator with the micro copy and no way
    // forward except remounting the screen. The pane now renders a retry
    // button bound to the same re-read the mount effect runs.
    const src = readPaneSource();
    expect(src).toMatch(/!shown\.loaded && shown\.failed \? \(/);
    const failed = src.match(/!shown\.loaded && shown\.failed \? \([\s\S]*?\) : null/)?.[0];
    expect(failed).toBeDefined();
    expect(failed).toMatch(/label="Retry"/);
    expect(failed).toMatch(/onPress=\{\(\) => void load\(\)\}/);
  });

  test('the retry is offered only on the failed-first-read path, never over a list', () => {
    // A failed re-read keeps the last good list with its own stale copy —
    // the retry must not render there, and a loaded pane must show no
    // button at all.
    const src = readPaneSource();
    expect(src).not.toMatch(/state\.failed && shown\.loaded/);
    expect(src).not.toMatch(/shown\.failed && shown\.loaded/);
  });

  test('the failed-first-read micro copy still names the failure', () => {
    const src = readPaneSource();
    expect(src).toMatch(/\{copy \? \(/);
  });

  test('a failed first read never renders as "No paired devices."', () => {
    // The lib keeps the two failures distinct: a failed first read claims
    // zero knowledge, and only a successful read may claim the Gate has
    // none. A junk envelope parses as a failed read, never an empty-ok list.
    const {
      applyPairedDevicesRead,
      EMPTY_PAIRED_DEVICES,
      pairedDevicesListCopy,
      pairedDevicesReadFromUnknown,
    } = jest.requireActual('@/lib/gateway/paired-devices') as typeof import(
      '@/lib/gateway/paired-devices'
    );
    const read = pairedDevicesReadFromUnknown({ unexpected: 'envelope' });
    expect(read).toEqual({ ok: false });
    const state = applyPairedDevicesRead(EMPTY_PAIRED_DEVICES, read);
    expect(pairedDevicesListCopy(state)).toBe('Paired devices could not be read.');
  });

  test('a row never carries a token', () => {
    const { pairedDeviceRowCopy } = jest.requireActual('@/lib/gateway/paired-devices') as typeof import(
      '@/lib/gateway/paired-devices'
    );
    const row = pairedDeviceRowCopy({
      deviceId: 'abc123',
      role: 'operator',
      scopes: ['operator.read'],
      issuedAtMs: 1_700_000_000_000,
      revoked: false,
    });
    expect(JSON.stringify(row)).not.toMatch(/token/i);
    expect(row.title).toBe('abc123');
  });
});
