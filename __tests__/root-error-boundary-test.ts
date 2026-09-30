// ─── Root error boundary, global JS handler, and the local failure log ─────
// Before this there was no ErrorBoundary export in src/app at all, so a render
// error in a provider ABOVE the Stack (GatewayProvider, FontProvider, the
// voice provider) unmounted the app with nothing recorded; an uncaught error in
// an event handler on a release build had no redbox to print; and a rejected
// promise nobody caught was invisible. Pinned off the source so the wiring
// cannot quietly disappear again, and so the startup order the rest of the app
// depends on (streaming fetch first, providers nested as they were) stays put.

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

const layout = () => readSource('src', 'app', '_layout.tsx');
const failureLog = () => readSource('src', 'lib', 'diagnostics', 'failure-log.ts');
const fallback = () => readSource('src', 'components', 'error-fallback.tsx');
const diagnostics = () => readSource('src', 'app', 'gateway', 'diagnostics.tsx');

describe('the root layout installs the global failure handlers once, at startup', () => {
  test('streaming fetch is still installed first — nothing may reorder it', () => {
    const src = layout();
    const streaming = src.indexOf('installStreamingFetch(expoFetch');
    const failures = src.indexOf('installGlobalFailureHandlers()');
    expect(streaming).toBeGreaterThan(-1);
    expect(failures).toBeGreaterThan(streaming);
  });

  test('the install sits at module scope, not inside a component or an effect', () => {
    const src = layout();
    // Before the first `function`/`export` declaration — i.e. while the module
    // is being evaluated, ahead of anything that can throw.
    const firstDeclaration = src.search(/^function \w|^export default function/m);
    expect(src.indexOf('installGlobalFailureHandlers()')).toBeLessThan(firstDeclaration);
  });

  test('the provider tree above the Stack is unchanged', () => {
    const src = layout();
    const order = [
      '<GatewayProvider>',
      '<HandsfreeVoiceProvider>',
      '<FontProvider>',
      '<ThemeProvider value={VersutusDarkTheme}>',
      '<AppBootstrap>',
      '<AppLockGate>',
      '<Stack',
      '</AppLockGate>',
      '</AppBootstrap>',
      '</ThemeProvider>',
      '</FontProvider>',
      '</HandsfreeVoiceProvider>',
      '</GatewayProvider>',
    ].map((needle) => src.indexOf(needle));
    expect(order).not.toContain(-1);
    for (let index = 1; index < order.length; index += 1) {
      expect(order[index]).toBeGreaterThan(order[index - 1]);
    }
  });
});

describe('the root layout exports the router contract ErrorBoundary', () => {
  test('it takes the Expo Router props and renders our own fallback', () => {
    const src = layout();
    expect(src).toContain('type ErrorBoundaryProps');
    expect(src).toMatch(/export function ErrorBoundary\(\{ error, retry \}: ErrorBoundaryProps\)/);
    expect(src).toContain('<ErrorFallback');
  });

  test('the crash is recorded as a render failure, in an effect', () => {
    const src = layout();
    const boundary = src.slice(src.indexOf('export function ErrorBoundary'));
    expect(boundary).toMatch(/useEffect\(/);
    expect(boundary).toContain("kind: 'render'");
    expect(boundary).toContain('recordFailure(');
  });

  test('retry is the router’s own, not a reload of the app', () => {
    const src = layout();
    const boundary = src.slice(src.indexOf('export function ErrorBoundary'));
    expect(boundary).toContain('retry');
    expect(boundary).not.toContain('DevSettings');
    expect(boundary).not.toContain('reloadAsync');
  });
});

describe('the failure log is a bounded, self-healing local record', () => {
  test('it persists under the versioned key through the shared key-value store', () => {
    const src = failureLog();
    expect(src).toContain("'versutus:failure-log:v1'");
    expect(src).toContain("from '@/lib/storage/key-value'");
    expect(src).toContain('keyValueStorage.setItem');
    expect(src).toContain('keyValueStorage.getItem');
    expect(src).toContain('keyValueStorage.removeItem');
  });

  test('it keeps the newest 50 entries and truncates what it stores', () => {
    const src = failureLog();
    expect(src).toMatch(/MAX_ENTRIES = 50/);
    expect(src).toMatch(/MESSAGE_LIMIT = 500/);
    expect(src).toMatch(/STACK_LIMIT = 2000/);
    expect(src).toContain('slice(0, MAX_ENTRIES)');
  });

  test('writes are serialized so two failures in the same tick both land', () => {
    const src = failureLog();
    expect(src).toContain('writeChain');
  });

  test('every storage touch is wrapped, because a logger that throws is a worse fault', () => {
    const src = failureLog();
    const setItem = src.slice(src.indexOf('keyValueStorage.setItem'));
    expect(setItem).toMatch(/catch \{/);
  });
});

describe('the global handlers record and then defer to the platform', () => {
  test('ErrorUtils is read and written through its own get/set pair', () => {
    const src = failureLog();
    expect(src).toContain('getGlobalHandler');
    expect(src).toContain('setGlobalHandler');
    // The previous handler is called after the record, not replaced by it.
    const handler = src.slice(src.indexOf('setGlobalHandler('));
    expect(handler).toMatch(/recordFailure\([\s\S]*?previous\?\.\(/);
  });

  test('the rejection tracker is chained to React Native’s own, never swapped out', () => {
    const src = failureLog();
    expect(src).toContain('enablePromiseRejectionTracker');
    expect(src).toContain('promiseRejectionTrackingOptions');
    const onUnhandled = src.slice(src.indexOf('onUnhandled:'));
    expect(onUnhandled).toContain("kind: 'unhandled-rejection'");
    expect(onUnhandled).toContain('rnOptions');
  });

  test('installing twice wraps once, and uninstall restores', () => {
    const src = failureLog();
    expect(src).toContain('if (uninstall) return uninstall;');
    expect(src).toContain('errorUtils.setGlobalHandler(previous)');
  });
});

describe('the fallback screen is plain and offers both ways out', () => {
  test('it names the failure and offers retry and copy', () => {
    const src = fallback();
    expect(src).toContain('Something went wrong');
    expect(src).toContain('label="Try again"');
    expect(src).toContain('label="Copy details"');
    expect(src).toContain('Clipboard.setStringAsync');
    expect(src).toContain("from '@/components/ui'");
  });
});

describe('the diagnostics screen shows the log the app kept', () => {
  test('Recent failures is the last section, with the empty state and a clear', () => {
    const src = diagnostics();
    expect(src).toContain('Recent failures');
    expect(src).toContain('No failures recorded');
    expect(src).toContain('label="Clear"');
    expect(src).toContain('loadFailures');
    expect(src).toContain('clearFailures');
  });

  test('it sits after the live check and the runtime environment card is intact', () => {
    const src = diagnostics();
    expect(src.indexOf('Recent failures')).toBeGreaterThan(src.indexOf('Run live check'));
    expect(src.indexOf('Recent failures')).toBeGreaterThan(src.indexOf('Runtime environment'));
    // The existing section headings stay at headline — one screen title only.
    expect(src).toContain('<Text variant="headline">Recent failures</Text>');
    expect((src.match(/variant="title"/g) ?? []).length).toBe(1);
  });
});
