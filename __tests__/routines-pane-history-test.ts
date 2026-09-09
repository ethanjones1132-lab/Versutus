import { cronJobViewFromRoutine, type RoutineJob } from '@/lib/gateway/routines';

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

const pane = () =>
  readSource('src', 'components', 'chat', 'routines-pane.tsx');
const section = () =>
  readSource('src', 'components', 'activity', 'cron-section.tsx');

// Tapping a routine row used to fire the job at the gateway and leave its
// run history buried on the Activity tab. The row now opens the same
// CronJobSheet Activity renders, so run history, Run now, and Remove live
// on the row's tap; Pause stays the trailing control on the row itself.
describe('routines pane row opens the scheduled-job sheet', () => {
  test('the row tap opens the job sheet instead of running the job', () => {
    const src = pane();
    expect(src).toMatch(/onPress=\{\(\) => setOpenJobId\(job\.id\)\}/);
    // The old fire-and-forget run path is gone: no run submitter and no
    // onRun prop remains in the pane.
    expect(src).not.toContain('submitRun');
    expect(src).not.toMatch(/\bonRun\b/);
  });

  test('the pane mounts the same CronJobSheet Activity renders, keyed on the job id', () => {
    const src = pane();
    expect(src).toContain("from '@/components/activity/cron-job-sheet'");
    const mount = src.match(/<CronJobSheet[\s\S]*?\/>/)?.[0];
    expect(mount).toBeDefined();
    expect(mount).toContain("key={openJob?.id ?? 'no-job'}");
    expect(mount).toContain('job={openJob ? cronJobViewFromRoutine(openJob) : null}');
    expect(mount).toMatch(/onClose=\{\(\) => setOpenJobId\(null\)\}/);
    expect(mount).toMatch(/onOpenRun=\{\(runId\) => setOpenRunId\(runId\)\}/);
  });

  test('a run transcript opens over the job sheet and closing it returns to the same job', () => {
    // Mirrors the proven Activity pattern: the run sheet hides nothing here
    // because the job sheet and run sheet never mount two BaseSheets at
    // once — the job id stays in state while the run is open, so closing
    // the run restores the same keyed job sheet with its RUN HISTORY.
    const src = pane();
    expect(src).toContain("from '@/components/activity/cron-run-sheet'");
    expect(src).toContain(
      "<CronRunSheet key={openRunId ?? 'no-run'} runId={openRunId} onClose={() => setOpenRunId(null)} />",
    );
    const runCloseIdx = src.indexOf('onClose={() => setOpenRunId(null)}');
    const jobCloseIdx = src.indexOf('onClose={() => setOpenJobId(null)}');
    expect(runCloseIdx).toBeGreaterThan(-1);
    expect(jobCloseIdx).toBeGreaterThan(-1);
    // Closing the run clears only the run id — never the job id.
    const runClose = src.slice(runCloseIdx, runCloseIdx + 60);
    expect(runClose).not.toContain('setOpenJobId(null)');
  });

  test('a confirmed Remove closes the sheet and re-reads so the row drops', () => {
    const src = pane();
    const mount = src.match(/<CronJobSheet[\s\S]*?\/>/)?.[0];
    expect(mount).toMatch(/onRemoved=\{\(\) => \{/);
    expect(mount).toContain('setOpenJobId(null);');
    expect(mount).toMatch(/onChanged=\{\(\) => \{/);
    expect(mount).toMatch(/onChanged\?\.\(\)/);
    // The parent re-read that drops the row is the surface's own retry
    // re-read, already stable across chat-screen ticks.
    const screen = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    expect(screen).toContain('onChanged={handleRoutinesRetry}');
  });

  test('Pause stays the trailing control on the row', () => {
    const src = pane();
    expect(src).toMatch(/label=\{job\.paused \? 'Resume' : 'Pause'\}/);
    expect(src).toMatch(/onPress=\{\(\) => submitPause\(job\.id, !job\.paused\)\}/);
    // The rendered row lives inside jobs.map — match past the doc comment
    // that also mentions ListRow.
    const row = src.slice(src.indexOf('jobs.map')).match(/<ListRow[\s\S]*?\n\s*\/>/)?.[0];
    expect(row).toBeDefined();
    expect(row).toContain('trailing=');
  });

  test('the New-routine form and its refusal-keeps-draft path are byte-identical', () => {
    const src = pane();
    expect(src).toMatch(/<Text variant="micro" color="secondary">\n\s*New routine\n\s*<\/Text>/);
    expect(src).toContain('<TextField value={title} onChangeText={setTitle} placeholder="inbox" />');
    expect(src).toContain(
      '<TextField value={schedule} onChangeText={setSchedule} placeholder={DEFAULT_ROUTINE_SCHEDULE} />',
    );
    expect(src).toContain(
      '<TextField value={prompt} onChangeText={setPrompt} placeholder="Summarize overnight mail" multiline />',
    );
    // Fail honest: a refused Add keeps the submitted draft and names why.
    expect(src).toMatch(
      /applyRoutineCreate\(submitted, \{ ok: false, cause \}\)/,
    );
    expect(src).toMatch(/setError\(next\.error\);/);
  });

  test('the failed-first-read Retry branch is byte-identical', () => {
    const src = pane();
    const failed = src.match(
      /!loaded && failed && onRetry \? \([\s\S]*?\) : null/,
    )?.[0];
    expect(failed).toBeDefined();
    expect(failed).toMatch(/label="Retry"/);
    expect(failed).toMatch(/onPress=\{onRetry\}/);
    expect(src.match(/label="Retry"/g)).toHaveLength(1);
  });

  test("Activity's CronJobSheet wiring is untouched", () => {
    // Chat gains the sheet; Activity keeps owning its own mount, its run
    // transcript hop, and its refresh contracts.
    const src = section();
    expect(src).toContain('<CronJobSheet');
    expect(src).toContain("key={openJob?.id ?? 'no-job'}");
    expect(src).toMatch(/onOpenRun=\{\(runId\) => \{/);
    expect(src).toMatch(/onRemoved=\{\(\) => \{/);
    expect(src).toMatch(/onChanged=\{\(\) => \{/);
  });
});

describe('cronJobViewFromRoutine', () => {
  test('title and owning Bot come from the [bot:<name>] convention', () => {
    const job: RoutineJob = {
      id: 'job-1',
      name: '[bot:claude] inbox',
      paused: true,
      schedule: '0 9 * * *',
      nextRunAt: '2026-09-10T09:00:00Z',
      lastStatus: 'ok',
      running: false,
    };
    expect(cronJobViewFromRoutine(job)).toEqual({
      id: 'job-1',
      title: 'inbox',
      name: '[bot:claude] inbox',
      botId: 'claude',
      schedule: '0 9 * * *',
      nextRunAt: '2026-09-10T09:00:00Z',
      lastStatus: 'ok',
      paused: true,
      running: false,
    });
  });

  test('a nameless job falls back to its id for the title, with no owning Bot', () => {
    expect(cronJobViewFromRoutine({ id: 'job-9' })).toEqual({
      id: 'job-9',
      title: 'job-9',
      name: null,
      botId: null,
      schedule: null,
      nextRunAt: null,
      lastStatus: null,
      paused: undefined,
      running: undefined,
    });
  });

  test('fields the slim routine read does not carry stay absent rather than guessed', () => {
    const view = cronJobViewFromRoutine({ id: 'job-2', name: '[bot:x] y' });
    expect(view.prompt).toBeUndefined();
    expect(view.model).toBeUndefined();
    expect(view.provider).toBeUndefined();
    expect(view.lastRunAt).toBeUndefined();
    expect(view.scheduleDisplay).toBeUndefined();
  });
});
