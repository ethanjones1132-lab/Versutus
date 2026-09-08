declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readProvider(): string {
  return readSource(['src', 'context', 'gateway-provider.tsx']);
}

function readActivity(): string {
  return readSource(['src', 'app', '(tabs)', 'activity.tsx']);
}

function readRuns(): string {
  return readSource(['src', 'lib', 'gateway', 'runs.ts']);
}

// `runTask` patches a provisional `local-` Running entry into activityRuns
// BEFORE `executeRun` calls `client.startRun`. When the gateway refuses the
// start, the throw skipped the `onStarted` re-key and the try/finally had no
// catch, so nothing ever settled the provisional — a permanently Running
// ghost in the In-flight filter that only an app kill cleared. The catch now
// settles the tracked id through the existing `patchRun` and rethrows, so
// the `sendChatInput` catch still names the refusal in chat.
describe('activity refused run settles the provisional card', () => {
  test('the runTask throw path settles the tracked provisional as failed', () => {
    const src = readProvider();
    expect(src).toContain('patchRun(trackedId.current, {');
    expect(src).toContain("status: 'failed',");
    expect(src).toContain('finishedAt: Date.now(),');
  });

  test('the catch rethrows so the chat verdict path still runs', () => {
    const src = readProvider();
    expect(src).toContain('throw error;');
  });

  test('the chat Command-failed bubble and lastError path stay byte-identical', () => {
    const src = readProvider();
    expect(src).toContain('setLastError(message);');
    expect(src).toContain('text: `Command failed: ${message}`,');
  });

  test('the onStarted local-to-real re-key stays byte-identical', () => {
    const src = readProvider();
    expect(src).toContain('prev.map((run) => (run.id === trackedId.current ? { ...run, id: runId } : run))');
    expect(src).toContain('trackedId.current = runId;');
  });

  test('the success settle through patchRun stays byte-identical', () => {
    const src = readProvider();
    expect(src).toContain('status: outcomeToActivityStatus(outcome),');
  });

  test('settleUnresolvedRuns still only re-polls unresolved runs', () => {
    const src = readRuns();
    expect(src).toContain("if (run.status !== 'unresolved') {");
  });

  test('the Activity prompt still clears after a successful start', () => {
    const src = readActivity();
    expect(src).toContain('await sendChatInput(`/run ${prompt}`);');
    expect(src).toContain("setRunPrompt('');");
  });
});
