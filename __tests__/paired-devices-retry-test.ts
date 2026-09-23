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
  test('a failed read offers a Retry through the ErrorCard wired to the load handler', () => {
    // A failed read used to leave the operator with micro copy plus a ghost
    // Retry button, and destroyed the thrown message at the catch. The pane
    // now keeps the message in `error` and renders the repo's ErrorCard —
    // cause/affected/next + Retry — bound to the same re-read.
    const src = readPaneSource();
    expect(src).toMatch(/\{shown\.failed \? \(\s*<ErrorCard/);
    const failed = src.match(/\{shown\.failed \? \(\s*<ErrorCard[\s\S]*?\) : null/)?.[0];
    expect(failed).toBeDefined();
    expect(failed).toMatch(/onRetry=\{\(\) => void load\(\)\}/);
    expect(src).not.toMatch(/label="Retry"/);
  });

  test('the ErrorCard gate is the failure alone, and a healthy read shows none', () => {
    // Both failure modes — a failed first read and a stale re-read — set
    // `shown.failed`, so both surface through the one ErrorCard (stale keeps
    // its list below the card). A completed successful read renders neither.
    const src = readPaneSource();
    expect(src).toMatch(/\{shown\.failed \? \(\s*<ErrorCard/);
    expect(src).not.toMatch(/!shown\.loaded && shown\.failed \? \(/);
    expect(src).not.toMatch(/\{shown\.loaded && !shown\.failed \? \(\s*<ErrorCard/);
  });

  test('the failure is named through the ErrorCard cause, falling back to the lib copy', () => {
    // The kept message wins; a junk envelope that failed without a throw
    // falls back to the lib's honest failure line. The standalone micro copy
    // renders only outside failures (the empty claim), never beside the card.
    const src = readPaneSource();
    expect(src).toMatch(/cause=\{error \?\? copy \?\? 'Paired devices could not be read\.'\}/);
    expect(src).toMatch(/\{!shown\.failed && copy \? \(/);
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
