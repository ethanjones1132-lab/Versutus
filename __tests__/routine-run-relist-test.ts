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

function routineCallback(src: string, name: string): string {
  const fn = src.match(
    new RegExp(
      `const ${name} = useCallback\\([\\s\\S]*?\\n  \\);`,
    ),
  )?.[0];
  expect(fn).toBeDefined();
  return fn ?? '';
}

// Tapping a routine row ran the job on the gateway but the pane kept the
// old verdict until the next surface read — pausing the same row re-read
// at once. Run now re-lists exactly like its two siblings.
describe('routine run re-lists the roster', () => {
  test('a successful run re-reads the routine list through the pause-shaped fold', () => {
    const src = screen();
    const fn = routineCallback(src, 'handleRoutineRun');
    expect(fn).toContain('await botJobs.run(jobId)');
    expect(fn).toContain('foldRoutineRead(target, { ok: true, jobs: routineJobsFromList(jobs) })');
    expect(fn).toContain('.catch(() => foldRoutineRead(target, { ok: false }))');
    // The re-list lands inside the success path, after the run landed —
    // a refused run throws before it and never reaches the fold.
    const runIdx = fn.indexOf('await botJobs.run(jobId)');
    const listIdx = fn.indexOf('.list()', runIdx);
    const catchIdx = fn.indexOf('.catch(', runIdx);
    expect(listIdx).toBeGreaterThan(runIdx);
    expect(catchIdx).toBeGreaterThan(listIdx);
  });

  test('a refused run never re-lists and the pane still names the refusal', () => {
    const src = screen();
    const fn = routineCallback(src, 'handleRoutineRun');
    // No try around the run: a Gate refusal propagates to the pane's
    // describeRoutineError instead of adopting a list the host refused.
    expect(fn).not.toContain('try {');
    expect(fn).not.toContain('describeRoutineError');
    const runIdx = fn.indexOf('await botJobs.run(jobId)');
    const foldIdx = fn.indexOf('foldRoutineRead(target, { ok: true');
    expect(foldIdx).toBeGreaterThan(runIdx);
    // The pane refusal path is untouched: a refused run keeps the draft
    // list and says why.
    const paneSrc = pane();
    expect(paneSrc).toMatch(
      /void Promise\.resolve\(onRun\(jobId\)\)\s*\.catch\(\(cause: unknown\) => \{\s*setError\(describeRoutineError\(cause\)\);/,
    );
  });

  test('a failed re-list after a landed run names staleness, never a refusal', () => {
    const src = screen();
    const fn = routineCallback(src, 'handleRoutineRun');
    // Mirrors the create-path comment: last-good stays, staleness is named.
    expect(fn).toContain('a failed re-list must not look like');
    expect(fn).toContain('the Gate refused the run');
    // The re-list failure folds { ok: false } — which keeps the last good
    // list once loaded — and never touches describeRoutineError.
    expect(fn).toContain('.catch(() => foldRoutineRead(target, { ok: false }))');
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

  test('all three routine callbacks stay memo-safe with stable identities', () => {
    const src = screen();
    const run = routineCallback(src, 'handleRoutineRun');
    expect(run).toContain(
      '[botSurfaceId, botJobs, foldRoutineRead, routineJobsFromList]',
    );
    const create = routineCallback(src, 'handleRoutineCreate');
    expect(create).toContain(
      '[botSurfaceId, botJobs, foldRoutineRead, routineJobsFromList]',
    );
    const pause = routineCallback(src, 'handleRoutineTogglePause');
    expect(pause).toContain(
      '[botSurfaceId, botJobs, foldRoutineRead, routineJobsFromList]',
    );
    // The run callback guards the non-bot surface exactly like create, so
    // the pane's React.memo wrapper holds across chat-screen ticks.
    expect(run).toContain('if (!botSurfaceId) return;');
    expect(run).toContain('const target = botSurfaceId;');
  });
});
