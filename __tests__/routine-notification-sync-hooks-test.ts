import {
  cancelRoutineNotification,
  syncRoutineNotification,
} from '@/lib/notifications/routine-sync';

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

const chatScreen = () => readSource('src', 'components', 'chat', 'chat-screen.tsx');
const sheet = () => readSource('src', 'components', 'activity', 'cron-job-sheet.tsx');
const cronSection = () => readSource('src', 'components', 'activity', 'cron-section.tsx');

function between(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start === -1) return '';
  const rest = src.slice(start + startMarker.length);
  const end = rest.indexOf(endMarker);
  return end === -1 ? rest : rest.slice(0, end);
}

test("the Bot Routines pane's create lands a scheduled local notice", () => {
  const src = chatScreen();
  const createFn = between(src, 'const handleRoutineCreate', 'const handleRoutineTogglePause');
  // Only a confirmed create syncs — the sync call must sit after the gateway
  // create resolves, and the created job's own id must drive the schedule.
  const createIdx = createFn.indexOf('botJobs.create');
  const syncIdx = createFn.indexOf('syncRoutineNotification');
  expect(createIdx).toBeGreaterThan(-1);
  expect(syncIdx).toBeGreaterThan(createIdx);
  expect(createFn).toContain('created?.id');
});

test("a confirmed pause or resume re-syncs the routine's local notice", () => {
  const src = chatScreen();
  const toggleFn = between(src, 'const handleRoutineTogglePause', 'useEffect(() =>');
  const pauseIdx = toggleFn.indexOf('botJobs.pause(jobId, paused)');
  const syncIdx = toggleFn.indexOf('syncRoutineNotification');
  const cancelIdx = toggleFn.indexOf('cancelRoutineNotification');
  // Fire-and-forget best-effort: the sync never sits in the awaited chain.
  expect(pauseIdx).toBeGreaterThan(-1);
  expect(syncIdx).toBeGreaterThan(pauseIdx);
  // A pause retires the held notice even when the re-list could not confirm
  // the job, so a stale schedule can never survive a pause.
  expect(cancelIdx).toBeGreaterThan(-1);
});

test("the scheduled-job sheet's Pause/Resume and Remove keep the local notice in step", () => {
  const src = sheet();
  const toggleFn = between(src, 'const submitTogglePause', 'const executeRemove');
  const removeFn = between(src, 'const executeRemove', 'useEffect(');
  expect(toggleFn).toContain('syncRoutineNotification');
  // Remove destroys the job: both the OS schedule and the persisted mapping go.
  expect(removeFn).toContain('cancelRoutineNotification(target)');
});

test("the Activity gateway-level create schedules no local notice", () => {
  const src = cronSection();
  const createFn = between(src, 'const submitCreate', 'if (status !==');
  const createIdx = createFn.indexOf('botJobs.create');
  expect(createIdx).toBeGreaterThan(-1);
  // A routine notice is Bot-bound by design — it opens that Bot's chat — and
  // this form's title is deliberately unprefixed so the job files as
  // gateway-level. The sync that used to sit here therefore parsed no botId,
  // withheld the notice and retired any held one: it could never schedule
  // anything, while its comment claimed the opposite.
  expect(createFn).not.toContain('syncRoutineNotification');
  // The create still lands and the roster is still re-read.
  expect(createFn).toContain('void load()');
});

test('the sync stays fire-and-forget — awaiting it in a mutation would fail the mutation on a locked scheduler', () => {
  // The cron section is not in this list because it no longer calls the sync
  // at all: a gateway-level job names no Bot, so it has no phone-side notice.
  for (const src of [chatScreen(), sheet()]) {
    // Every call site hands the promise to void / best-effort, never await.
    expect(src).toMatch(/void (syncRoutineNotification|cancelRoutineNotification)\(/);
  }
});
