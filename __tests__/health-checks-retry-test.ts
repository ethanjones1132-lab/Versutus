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
    expect(src).toMatch(/cause=\{error \?\? copy \?\? 'Health checks could not be read\.'\}/);
    expect(src).toMatch(/\{!shown\.failed && copy \? \(/);
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
