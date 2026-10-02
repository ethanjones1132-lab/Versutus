// V-1 and V-2 are provider wiring, not pure folds: the refs `runTask` installs
// and the approval card it sets. The provider is not rendered here (the run
// path needs a live client); these pin the exact wiring the rendered harness
// would otherwise have to reproduce, the same source-lock pattern the Activity
// owner-action tests use.

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readProvider(): string {
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function between(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start === -1) return '';
  const rest = src.slice(start + startMarker.length);
  const end = rest.indexOf(endMarker);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('overlapping runs keep their own stop handle (V-1)', () => {
  test('the finally clears a ref only when it still holds this call’s handle', () => {
    const src = readProvider();
    // The whole runTask body up to the end of its dependency array.
    const body = between(src, 'const runTask = useCallback(', '[patchActivityRuns, status],');
    expect(body).toContain('if (runAbortControllerRef.current === abortController)');
    expect(body).toContain('if (activeRunTaskIdRef.current === trackedId.current)');
    // An unconditional pair here is the defect: the later run's finally wipes
    // the earlier run's handle and leaves it unstoppable.
    const finallyBlock = between(body, '} finally {', '    },\n');
    expect(finallyBlock).not.toMatch(/runAbortControllerRef\.current = null;\s*\n\s*activeRunTaskIdRef\.current = null;/);
  });
});

describe('an aborted approval wait clears the card (V-2)', () => {
  test('the abort listener drops the pending approval before resolving', () => {
    const src = readProvider();
    const onAbort = between(src, 'const onAbort = () => {', '};');
    expect(onAbort).toContain('setPendingRunApproval(null)');
    expect(onAbort).toContain('resolve({ approved: false })');
  });
});
