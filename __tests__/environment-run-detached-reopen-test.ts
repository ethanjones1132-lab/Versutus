declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readLauncher(): string {
  return readSource(['src', 'components', 'gateway', 'environment-run-launcher.tsx']);
}

function readDetached(): string {
  const src = readLauncher();
  const start = src.indexOf('{detached ? (');
  const end = src.indexOf('{approval ? (', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

// A run whose stream ends before a terminal event sets detached, and the
// caption names Recent runs as the way back — but Recent runs is best-effort
// (listRuns failure folds to []), so the only attach affordance can be gone
// while activeRunId is still known. Gate a Reopen button on
// detached && activeRunId so the dead end cannot happen.
describe('CLI run launcher offers Reopen on a detached run', () => {
  test('the detached block renders a Reopen button calling attach with the active run id', () => {
    const detached = readDetached();
    expect(detached).toContain('label="Reopen"');
    expect(detached).toContain('onPress={() => void attach(activeRunId)}');
  });

  test('Reopen renders only when detached and a run id is known', () => {
    const detached = readDetached();
    expect(detached.startsWith('{detached ? (')).toBe(true);
    expect(detached).toContain('{activeRunId ? (');
  });

  test('Reopen is disabled while a follow is live or no environment is selected', () => {
    const detached = readDetached();
    expect(detached).toContain('disabled={!environment || running}');
  });

  test('the detached caption copy stays byte-identical', () => {
    const detached = readDetached();
    expect(detached).toContain(
      'The connection ended before the run finished. Reopen it from Recent runs — the full output replays.',
    );
  });

  test('Recent runs rows still attach on tap, gated on running', () => {
    const src = readLauncher();
    expect(src).toContain('onPress={running ? undefined : () => void attach(run.runId)}');
  });

  test('Start run, Cancel run, and Close stay untouched', () => {
    const src = readLauncher();
    expect(src).toContain('label="Start run"');
    expect(src).toContain('label="Cancel run"');
    expect(src).toContain('onPress={() => void cancel()}');
    expect(src).toContain('<Button label="Close" variant="secondary" onPress={onClose} />');
  });

  test('the attach guard stays untouched', () => {
    const src = readLauncher();
    const attachAt = src.indexOf('async function attach(');
    const cancelAt = src.indexOf('async function cancel()');
    expect(attachAt).toBeGreaterThanOrEqual(0);
    expect(cancelAt).toBeGreaterThan(attachAt);
    const attachFn = src.slice(attachAt, cancelAt);
    expect(attachFn).toContain('if (!environment || running) return;');
    expect(attachFn).toContain('setActiveRunId(runId);');
  });
});
