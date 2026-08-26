import {
  applyRoutineCreate,
  applyRoutineRead,
  describeRoutineError,
  EMPTY_ROUTINES,
  parseRoutineName,
  routineJobFromUnknown,
  routineJobsFromList,
  routineJobSummary,
  routineName,
  routinesListCopy,
  routinesToggleLabel,
  type RoutineJob,
} from '@/lib/gateway/routines';

test('routineName namespaces a job to a bot', () => {
  expect(routineName('researcher', 'inbox')).toBe('[bot:researcher] inbox');
  expect(parseRoutineName('[bot:researcher] inbox')).toEqual({ botId: 'researcher', title: 'inbox' });
  expect(parseRoutineName('plain')).toEqual({ title: 'plain' });
});

const INBOX_DRAFT = {
  title: 'inbox',
  prompt: 'Summarize overnight mail',
  schedule: '30 8 * * 1',
};

test('a refused routine create keeps the submitted fields and names why', () => {
  const next = applyRoutineCreate(INBOX_DRAFT, {
    ok: false,
    cause: new Error('bot "echo" has no API_SERVER_KEY'),
  });
  expect(next.draft).toEqual(INBOX_DRAFT);
  expect(next.error).toContain('Bot has no listen key');
  expect(next.error).toContain('bot "echo" has no API_SERVER_KEY');
});

test('an accepted routine create empties title and prompt, keeps the schedule, and is silent', () => {
  const next = applyRoutineCreate(INBOX_DRAFT, { ok: true });
  expect(next.draft).toEqual({ title: '', prompt: '', schedule: '30 8 * * 1' });
  expect(next.error).toBeUndefined();
});

test('describeRoutineError classifies a listen-key refusal the same way other surfaces do', () => {
  const shown = describeRoutineError(new Error('bot "writer" has no API_SERVER_KEY'));
  expect(shown).toContain('Bot has no listen key');
  expect(shown).toContain('bot "writer" has no API_SERVER_KEY');
  expect(shown).toContain("Set API_SERVER_KEY in the profile's .env on the host, then retry.");
});

test('describeRoutineError keeps unclassifiable refusals raw', () => {
  expect(describeRoutineError(new Error('cron already exists'))).toBe('cron already exists');
  expect(describeRoutineError('This gateway does not manage jobs.')).toBe(
    'This gateway does not manage jobs.',
  );
});

test('describeRoutineError accepts Error instances and plain strings alike', () => {
  expect(describeRoutineError(new Error('cron already exists'))).toBe('cron already exists');
  expect(describeRoutineError('cron already exists')).toBe('cron already exists');
});

const INBOX: RoutineJob = { id: 'job_inbox', name: '[bot:echo] inbox', paused: false };
const NIGHTLY: RoutineJob = { id: 'job_nightly', name: '[bot:echo] nightly', paused: true };

test('a successful first read is believed, even when empty', () => {
  const next = applyRoutineRead(EMPTY_ROUTINES, { ok: true, jobs: [] });
  expect(next.jobs).toEqual([]);
  expect(next.loaded).toBe(true);
  expect(next.failed).toBe(false);
  expect(routinesToggleLabel(next, false)).toBe('Routines (0)');
  expect(routinesListCopy(next)).toBeUndefined();
});

test('a successful first read with jobs replaces the unread list', () => {
  const next = applyRoutineRead(EMPTY_ROUTINES, { ok: true, jobs: [INBOX, NIGHTLY] });
  expect(next.jobs).toEqual([INBOX, NIGHTLY]);
  expect(next.loaded).toBe(true);
  expect(next.failed).toBe(false);
  expect(routinesToggleLabel(next, false)).toBe('Routines (2)');
  expect(routinesListCopy(next)).toBeUndefined();
});

test('a failed FIRST read claims zero knowledge — not Routines (0)', () => {
  const next = applyRoutineRead(EMPTY_ROUTINES, { ok: false });
  expect(next.jobs).toEqual([]);
  expect(next.loaded).toBe(false);
  expect(next.failed).toBe(true);
  expect(routinesToggleLabel(next, false)).toBe('Routines');
  expect(routinesToggleLabel(next, false)).not.toContain('0');
  expect(routinesListCopy(next)).toBe('Routines could not be read.');
});

test('a failed RE-read keeps the last good list and names the staleness', () => {
  const loaded = applyRoutineRead(EMPTY_ROUTINES, { ok: true, jobs: [INBOX, NIGHTLY] });
  const stale = applyRoutineRead(loaded, { ok: false });
  expect(stale.jobs).toEqual([INBOX, NIGHTLY]);
  expect(stale.loaded).toBe(true);
  expect(stale.failed).toBe(true);
  expect(routinesToggleLabel(stale, false)).toBe('Routines (2)');
  expect(routinesListCopy(stale)).toBe('Could not re-read routines — showing the last list.');
});

test('a failed re-read of an empty-ok list stays empty and still names the failure', () => {
  const previous = applyRoutineRead(EMPTY_ROUTINES, { ok: true, jobs: [] });
  const next = applyRoutineRead(previous, { ok: false });
  expect(next.jobs).toEqual([]);
  expect(next.loaded).toBe(true);
  expect(next.failed).toBe(true);
  expect(routinesToggleLabel(next, false)).toBe('Routines (0)');
  expect(routinesListCopy(next)).toBe('Could not re-read routines — showing the last list.');
});

test('a successful EMPTY read is believed — the Bot really has none now', () => {
  const previous = applyRoutineRead(EMPTY_ROUTINES, { ok: true, jobs: [INBOX] });
  const next = applyRoutineRead(previous, { ok: true, jobs: [] });
  expect(next).toEqual({ jobs: [], loaded: true, failed: false });
  expect(routinesToggleLabel(next, false)).toBe('Routines (0)');
  expect(routinesListCopy(next)).toBeUndefined();
});

test('a successful refresh replaces the list and clears the failure', () => {
  const previous = applyRoutineRead(EMPTY_ROUTINES, { ok: true, jobs: [INBOX] });
  const stale = applyRoutineRead(previous, { ok: false });
  const next = applyRoutineRead(stale, { ok: true, jobs: [NIGHTLY] });
  expect(next.jobs).toEqual([NIGHTLY]);
  expect(next.failed).toBe(false);
  expect(routinesListCopy(next)).toBeUndefined();
});

test('the open toggle hides the count the way Skills does', () => {
  const loaded = applyRoutineRead(EMPTY_ROUTINES, { ok: true, jobs: [INBOX] });
  expect(routinesToggleLabel(loaded, true)).toBe('Hide routines');
  expect(routinesToggleLabel(EMPTY_ROUTINES, false)).toBe('Routines');
  expect(routinesListCopy(EMPTY_ROUTINES)).toBeUndefined();
});

const HERMES_INBOX = {
  id: 'job_inbox',
  name: '[bot:echo] inbox',
  schedule: '0 9 * * *',
  schedule_display: 'daily at 09:00',
  enabled: true,
  next_run_at: '2026-08-25T09:06:00Z',
  last_status: 'ok',
};

test('a Hermes job keeps schedule, next run, and last status', () => {
  expect(routineJobFromUnknown(HERMES_INBOX)).toEqual({
    id: 'job_inbox',
    name: '[bot:echo] inbox',
    paused: false,
    schedule: '0 9 * * *',
    nextRunAt: '2026-08-25T09:06:00Z',
    lastStatus: 'ok',
  });
});

test('a camelCase job (already curated) parses the same fields', () => {
  expect(
    routineJobFromUnknown({
      id: 'job_inbox',
      name: '[bot:echo] inbox',
      paused: false,
      schedule: '0 9 * * *',
      nextRunAt: '2026-08-25T09:06:00Z',
      lastStatus: 'ok',
    }),
  ).toEqual({
    id: 'job_inbox',
    name: '[bot:echo] inbox',
    paused: false,
    schedule: '0 9 * * *',
    nextRunAt: '2026-08-25T09:06:00Z',
    lastStatus: 'ok',
  });
});

test('enabled: false is a paused routine, the way Activity reads it', () => {
  expect(routineJobFromUnknown({ id: 'job_inbox', enabled: false })?.paused).toBe(true);
  expect(routineJobFromUnknown({ id: 'job_inbox', paused: true })?.paused).toBe(true);
  expect(routineJobFromUnknown({ id: 'job_inbox', paused_at: '2026-08-25T08:00:00Z' })?.paused).toBe(
    true,
  );
});

test('a job without an id is not a routine', () => {
  expect(routineJobFromUnknown({ name: 'inbox' })).toBeNull();
  expect(routineJobFromUnknown(null)).toBeNull();
  expect(routineJobFromUnknown('job_inbox')).toBeNull();
});

test('routineJobsFromList keeps parseable jobs and drops junk', () => {
  expect(routineJobsFromList([HERMES_INBOX, { name: 'no-id' }, null])).toEqual([
    {
      id: 'job_inbox',
      name: '[bot:echo] inbox',
      paused: false,
      schedule: '0 9 * * *',
      nextRunAt: '2026-08-25T09:06:00Z',
      lastStatus: 'ok',
    },
  ]);
  expect(routineJobsFromList({ data: [HERMES_INBOX] })).toEqual([]);
});

test('the routine subtitle is the Activity one-liner, not paused/active', () => {
  const now = Date.parse('2026-08-25T09:00:00Z');
  const inbox = routineJobFromUnknown(HERMES_INBOX);
  expect(inbox).not.toBeNull();
  if (!inbox) return;
  expect(routineJobSummary(inbox, now)).toBe('ok · next in 6m');
});

test('a paused routine says Paused even when a next run is known', () => {
  const now = Date.parse('2026-08-25T09:00:00Z');
  const paused = routineJobFromUnknown({ ...HERMES_INBOX, enabled: false });
  expect(paused).not.toBeNull();
  if (!paused) return;
  expect(routineJobSummary(paused, now)).toBe('Paused');
});

test('a running routine says so above the countdown', () => {
  const now = Date.parse('2026-08-25T09:00:00Z');
  const running = routineJobFromUnknown({
    ...HERMES_INBOX,
    latest_execution: { status: 'running' },
  });
  expect(running).not.toBeNull();
  if (!running) return;
  expect(routineJobSummary(running, now)).toBe('running now');
});

test('a job the host has never run is Not run yet, not active', () => {
  const job = routineJobFromUnknown({ id: 'job_new', name: '[bot:echo] new' });
  expect(job).not.toBeNull();
  if (!job) return;
  expect(routineJobSummary(job)).toBe('Not run yet');
});

