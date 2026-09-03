import { canCreateGatewayJob, gatewayJobInput } from '@/lib/gateway/cron-create';
import { applyRoutineCreate, DEFAULT_ROUTINE_SCHEDULE } from '@/lib/gateway/routines';

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

const section = () =>
  readSource('src', 'components', 'activity', 'cron-section.tsx');

test('the gateway job body carries the raw title, trimmed prompt, and schedule', () => {
  expect(
    gatewayJobInput({ title: '  Overnight mail  ', prompt: '  Summarize it  ', schedule: '0 8 * * *' }),
  ).toEqual({ name: 'Overnight mail', prompt: 'Summarize it', schedule: '0 8 * * *' });
});

test('a blank schedule falls back to the Routines pane default', () => {
  expect(
    gatewayJobInput({ title: 't', prompt: 'p', schedule: '   ' }).schedule,
  ).toBe(DEFAULT_ROUTINE_SCHEDULE);
});

test('the gateway body never carries a Bot Routine prefix', () => {
  const body = gatewayJobInput({ title: 'inbox', prompt: 'p', schedule: '0 9 * * *' });
  expect(body.name).toBe('inbox');
  expect(body.name).not.toContain('[bot:');
});

test('a create needs a title and a prompt, like the Routines pane Add guard', () => {
  expect(canCreateGatewayJob({ title: 't', prompt: 'p', schedule: '' })).toBe(true);
  expect(canCreateGatewayJob({ title: '   ', prompt: 'p', schedule: '' })).toBe(false);
  expect(canCreateGatewayJob({ title: 't', prompt: '  ', schedule: '' })).toBe(false);
});

test('the shared create discipline clears only on success and names the refusal', () => {
  const ok = applyRoutineCreate(
    { title: 't', prompt: 'p', schedule: '0 8 * * *' },
    { ok: true },
  );
  expect(ok.draft).toEqual({ title: '', prompt: '', schedule: '0 8 * * *' });
  const failed = applyRoutineCreate(
    { title: 't', prompt: 'p', schedule: '0 8 * * *' },
    { ok: false, cause: new Error('job "t" is locked') },
  );
  expect(failed.draft).toEqual({ title: 't', prompt: 'p', schedule: '0 8 * * *' });
  expect(failed.error).toContain('job "t" is locked');
});

test('the Activity tab carries a create control with title, schedule, and prompt', () => {
  const src = section();
  expect(src).toContain('New scheduled job');
  expect(src).toContain('placeholder="Overnight mail summary"');
  expect(src).toContain(`placeholder={DEFAULT_ROUTINE_SCHEDULE}`);
  expect(src).toContain('placeholder="Summarize overnight mail"');
  expect(src).toContain("'Add'");
  expect(src).toContain('canCreateGatewayJob');
});

test('the create posts the gateway-level body through the existing job client', () => {
  const src = section();
  expect(src).toContain('botJobs.create(gatewayJobInput(submitted))');
});

test('the Activity create never prefixes a Bot Routine name', () => {
  const src = section();
  // No routineName call anywhere in the section: the title goes out raw
  // through gatewayJobInput, so the Gate files a gateway-level job.
  expect(src).not.toContain('routineName');
  expect(src).toContain('botJobs.create(gatewayJobInput(submitted))');
});

test('a rejected create names the failure and keeps the draft', () => {
  const src = section();
  expect(src).toContain('applyRoutineCreate(submitted, { ok: false, cause })');
  expect(src).toContain('setCreateError(next.error)');
  // The refusal path restores the submitted fields so the operator can retry.
  const catchFn = src.slice(src.indexOf('{ ok: false, cause }'));
  expect(catchFn).toContain('setTitle(next.draft.title)');
  expect(catchFn).toContain('setPrompt(next.draft.prompt)');
  expect(catchFn).toContain('setSchedule(next.draft.schedule)');
});

test('a confirmed create clears the draft and re-reads the gateway job list', () => {
  const src = section();
  expect(src).toContain('applyRoutineCreate(submitted, { ok: true })');
  const okFn = src.slice(
    src.indexOf('{ ok: true }'),
    src.indexOf('{ ok: false, cause }'),
  );
  expect(okFn).toContain('void load()');
});

test('the create control sits below the gateway job list', () => {
  const src = section();
  const listIdx = src.indexOf('sorted.map((job)');
  const createIdx = src.indexOf('New scheduled job');
  expect(listIdx).toBeGreaterThan(-1);
  expect(createIdx).toBeGreaterThan(listIdx);
});

test('the job list, run transcript reads, and job controls stay untouched', () => {
  const src = section();
  expect(src).toContain('sortCronJobs(jobs)');
  expect(src).toContain('cronJobSummary(job)');
  expect(src).toContain('setOpenJob(job)');
  expect(src).toContain('await cron.list()');
  expect(src).toContain('<CronJobSheet');
  expect(src).toContain('<CronRunSheet');
  expect(src).toContain('onOpenRun={(runId)');
});
