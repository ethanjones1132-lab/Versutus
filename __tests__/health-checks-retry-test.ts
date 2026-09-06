declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readPaneSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'gateway', 'health-checks-pane.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('health-checks retry', () => {
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

  test('a failed first read never renders as "No health checks."', () => {
    // The lib keeps the two failures distinct: a failed first read claims
    // zero knowledge, and only a successful read may claim the gateway has
    // none. A junk envelope parses as a failed read, never an empty-ok list.
    const {
      applyDiagnosticsRead,
      EMPTY_DIAGNOSTICS,
      healthChecksListCopy,
      diagnosticsReadFromUnknown,
    } = jest.requireActual('@/lib/gateway/diagnostics-read') as typeof import(
      '@/lib/gateway/diagnostics-read'
    );
    const read = diagnosticsReadFromUnknown({ unexpected: 'envelope' });
    expect(read).toEqual({ ok: false });
    const state = applyDiagnosticsRead(EMPTY_DIAGNOSTICS, read);
    expect(healthChecksListCopy(state)).toBe('Health checks could not be read.');
  });

  test('a failed re-read keeps the last good list and marks it stale', () => {
    const { applyDiagnosticsRead, healthChecksListCopy } = jest.requireActual(
      '@/lib/gateway/diagnostics-read',
    ) as typeof import('@/lib/gateway/diagnostics-read');
    const loaded = applyDiagnosticsRead(
      { status: '', checks: [], loaded: false, failed: false },
      { ok: true, status: 'ok', checks: [{ name: 'db', status: 'ok' }] },
    );
    const stale = applyDiagnosticsRead(loaded, { ok: false });
    expect(stale.loaded).toBe(true);
    expect(stale.checks).toHaveLength(1);
    expect(healthChecksListCopy(stale)).toBe(
      'Could not re-read health checks — showing the last list.',
    );
  });
});
