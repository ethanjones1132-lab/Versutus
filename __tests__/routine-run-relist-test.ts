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

const screen = () =>
  readSource('src', 'components', 'chat', 'chat-screen.tsx');
const pane = () =>
  readSource('src', 'components', 'chat', 'routines-pane.tsx');
const sheet = () =>
  readSource('src', 'components', 'activity', 'cron-job-sheet.tsx');

function routineCallback(src: string, name: string): string {
  const fn = src.match(
    new RegExp(
      `const ${name} = useCallback\\([\\s\\S]*?\\n  \\);`,
    ),
  )?.[0];
  expect(fn).toBeDefined();
  return fn ?? '';
}

// A routine row tap no longer runs the job on the gateway — it opens the
// same CronJobSheet Activity renders, and that sheet's Run now / Pause /
// Remove re-lists the routine roster through the retry-shaped fold, exactly
// like the create and pause siblings. These pins replaced the old
// handleRoutineRun pins when the tap behavior moved into the sheet.
describe('routine sheet actions re-list the roster', () => {
  test('a landed Run now / Pause / Remove re-reads the routine list through the retry-shaped fold', () => {
    const src = screen();
    expect(src).toContain('onChanged={handleRoutinesRetry}');
    const retry = routineCallback(src, 'handleRoutinesRetry');
    expect(retry).toContain('botJobs');
    expect(retry).toMatch(/\.list\(\)/);
    expect(retry).toMatch(/applyRoutineRead\(previous,\s*\{\s*ok:\s*true,\s*jobs:\s*routineJobsFromList\(jobs\)/);
    // The re-read failure folds { ok: false } — which keeps the last good
    // list once loaded — and never names a refusal.
    expect(retry).toMatch(/applyRoutineRead\(previous,\s*\{\s*ok:\s*false\s*\}/);
  });

  test('the pane forwards the sheet refresh to the same re-read callback, and only after a landed action', () => {
    const src = pane();
    const sheetMount = src.match(/<CronJobSheet[\s\S]*?\/>/)?.[0];
    expect(sheetMount).toBeDefined();
    expect(sheetMount).toContain('onChanged={() => {');
    expect(sheetMount).toMatch(/onChanged\?\.\(\)/);
    // Remove also closes the sheet: the open job no longer exists, so the
    // row must drop and the sheet must not linger over a ghost job.
    expect(sheetMount).toContain('setOpenJobId(null);');
    // The sheet's own Run now calls onChanged inside its try block — a
    // refusal jumps to catch and never reaches it — so a refused action
    // never triggers the parent re-read.
    const sheetSrc = sheet();
    const toggle = sheetSrc.match(/const submitRun = useCallback\([\s\S]*?\n  \}, \[acting, botJobs, jobId, loadRuns, onChanged\]\);/)?.[0];
    expect(toggle).toBeDefined();
    const tryBlock = toggle?.match(/try \{[\s\S]*?\n    \} catch/)?.[0] ?? '';
    expect(tryBlock).toContain('onChanged?.()');
    const catchBlock = toggle?.match(/catch \(caught\) \{[\s\S]*?\n    \}/)?.[0] ?? '';
    expect(catchBlock).not.toContain('onChanged');
  });

  test('the pane no longer runs a job itself: no run callback, no submitRun', () => {
    // The old tap ran the job through `submitRun` + an `onRun` prop and
    // named a refusal through describeRoutineError. Both are gone — the
    // refusal now lands in the sheet's own controlError.
    const src = pane();
    expect(src).not.toContain('submitRun');
    expect(src).not.toMatch(/\bonRun\b/);
    expect(src).not.toContain('handleRoutineRun');
    const sheetSrc = sheet();
    expect(sheetSrc).toContain('describeCronJobControlError');
  });

  test('the create and pause siblings are byte-identical to the proven shape', () => {
    const src = screen();
    const create = routineCallback(src, 'handleRoutineCreate');
    expect(create).toContain('await botJobs.create({');
    expect(create).toContain('name: routineName(target, input.title),');
    expect(create).toContain(
      'foldRoutineRead(target, { ok: true, jobs: routineJobsFromList(jobs) })',
    );
    expect(create).toContain('.catch(() => foldRoutineRead(target, { ok: false }));');
    const pause = routineCallback(src, 'handleRoutineTogglePause');
    expect(pause).toContain('await botJobs.pause(jobId, paused);');
    expect(pause).toContain(
      'foldRoutineRead(botSurfaceId ?? \'\', { ok: true, jobs: routineJobsFromList(jobs) })',
    );
    expect(pause).toContain('.catch(() => foldRoutineRead(botSurfaceId ?? \'\', { ok: false }));');
  });

  test('the remaining routine callbacks stay memo-safe with stable identities', () => {
    const src = screen();
    const create = routineCallback(src, 'handleRoutineCreate');
    expect(create).toContain(
      '[botSurfaceId, botJobs, foldRoutineRead, routineJobsFromList]',
    );
    const pause = routineCallback(src, 'handleRoutineTogglePause');
    expect(pause).toContain(
      '[botSurfaceId, botJobs, foldRoutineRead, routineJobsFromList]',
    );
    const retry = routineCallback(src, 'handleRoutinesRetry');
    expect(retry).toContain('[botSurfaceId, status, botJobs]');
    // The create callback guards the non-bot surface, so the pane's
    // React.memo wrapper holds across chat-screen ticks.
    expect(create).toContain('if (!botSurfaceId) return;');
    expect(create).toContain('const target = botSurfaceId;');
  });
});
