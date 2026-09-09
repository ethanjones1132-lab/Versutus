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

function readDecide(): string {
  const src = readLauncher();
  const start = src.indexOf('async function decide');
  const end = src.indexOf('const badge', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

// decide used to catch a refused approveRun into setError and then
// unconditionally setApproval(null), so the caption named the refusal
// while Approve/Deny vanished and the run stayed waiting on the Gate.
// Clear the approval only after a successful decide so a refusal keeps
// the buttons for a retry.
describe('CLI run launcher keeps Approve/Deny on a refused decide', () => {
  test('decide clears the approval only after a successful approveRun', () => {
    const decide = readDecide();
    const tryAt = decide.indexOf('try {');
    const catchAt = decide.indexOf('} catch');
    expect(tryAt).toBeGreaterThanOrEqual(0);
    expect(catchAt).toBeGreaterThan(tryAt);
    const tryBlock = decide.slice(tryAt, catchAt);
    expect(tryBlock).toContain('await client.approveRun(environment.id, activeRunId, approval.id, decision);');
    expect(tryBlock).toContain('setApproval(null);');
    expect(tryBlock.indexOf('setApproval(null);')).toBeGreaterThan(
      tryBlock.indexOf('await client.approveRun(environment.id, activeRunId, approval.id, decision);'),
    );
  });

  test('a refused decide names the reason and keeps the approval', () => {
    const decide = readDecide();
    const catchAt = decide.indexOf('} catch');
    expect(catchAt).toBeGreaterThanOrEqual(0);
    const catchBlock = decide.slice(catchAt);
    expect(catchBlock).toContain('setError(caught instanceof Error ? caught.message : String(caught));');
    expect(catchBlock).not.toContain('setApproval(null);');
  });

  test('Approve and Deny still render while an approval is pending', () => {
    const src = readLauncher();
    expect(src).toContain('{approval ? (');
    expect(src).toContain('label="Approve"');
    expect(src).toContain("onPress={() => void decide('approve')}");
    expect(src).toContain('label="Deny"');
    expect(src).toContain("onPress={() => void decide('deny')}");
  });

  test('formatRunFailure copy stays byte-identical', () => {
    const src = readLauncher();
    expect(src).toContain('{formatRunFailure(error) ?? error}');
    expect(src).toContain('{formatRunFailure(view.failureDetail) ?? view.failureDetail}');
  });

  test('start and attach still clear the approval when beginning a new follow', () => {
    const src = readLauncher();
    const startAt = src.indexOf('async function start()');
    const attachAt = src.indexOf('async function attach(');
    const decideAt = src.indexOf('async function decide');
    expect(startAt).toBeGreaterThanOrEqual(0);
    expect(attachAt).toBeGreaterThan(startAt);
    expect(decideAt).toBeGreaterThan(attachAt);
    const startFn = src.slice(startAt, attachAt);
    const attachFn = src.slice(attachAt, decideAt);
    expect(startFn).toContain('setApproval(null);');
    expect(attachFn).toContain('setApproval(null);');
  });

  test('the decide guard and approveRun arguments stay untouched', () => {
    const decide = readDecide();
    expect(decide).toContain("if (!environment || !activeRunId || !approval) return;");
    expect(decide).toContain("async function decide(decision: 'approve' | 'deny')");
    expect(decide).toContain('await client.approveRun(environment.id, activeRunId, approval.id, decision);');
  });
});
