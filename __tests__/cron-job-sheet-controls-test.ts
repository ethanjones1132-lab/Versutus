import {
  cronJobPauseLabel,
  describeCronJobControlError,
} from '@/lib/gateway/cron-job-controls';

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

const sheet = () =>
  readSource('src', 'components', 'activity', 'cron-job-sheet.tsx');

test('a paused job offers Resume, a live one offers Pause', () => {
  expect(cronJobPauseLabel({ paused: true })).toBe('Resume');
  expect(cronJobPauseLabel({ paused: false })).toBe('Pause');
});

test('a refused control call names the failure instead of swallowing it', () => {
  expect(describeCronJobControlError(new Error('job "inbox" is locked'))).toContain(
    'job "inbox" is locked',
  );
  expect(describeCronJobControlError('This gateway does not run jobs.')).toBe(
    'This gateway does not run jobs.',
  );
});

test('the sheet offers Run now and Pause/Resume below the health line', () => {
  const src = sheet();
  expect(src).toContain('Run now');
  expect(src).toContain('cronJobPauseLabel');
  const healthIdx = src.indexOf('health.label');
  const runIdx = src.indexOf('Run now');
  const pauseIdx = src.indexOf('cronJobPauseLabel({ paused })');
  expect(healthIdx).toBeGreaterThan(-1);
  expect(runIdx).toBeGreaterThan(healthIdx);
  expect(pauseIdx).toBeGreaterThan(healthIdx);
});

test('the controls drive the existing gateway job client', () => {
  const src = sheet();
  expect(src).toContain('botJobs.run(jobId)');
  expect(src).toContain('botJobs.pause(jobId, !paused)');
});

test('a rejected control call surfaces the named error and keeps the last good pause state', () => {
  const src = sheet();
  // The failure names itself through the shared routine-error copy.
  expect(src).toContain('setControlError(describeCronJobControlError(caught))');
  // Only a confirmed Pause/Resume may move the label; a refusal leaves the
  // override alone so it still reads the last good state.
  const pauseFn = src.slice(src.indexOf('submitTogglePause'), src.indexOf('}, [acting, botJobs, jobId, paused])'));
  expect(pauseFn).toContain('setPausedOverride(!paused)');
  const catchIdx = pauseFn.indexOf('catch');
  const overrideIdx = pauseFn.indexOf('setPausedOverride(!paused)');
  expect(catchIdx).toBeGreaterThan(-1);
  expect(overrideIdx).toBeLessThan(catchIdx);
});

test('the runs list and read-only run transcript reads stay untouched', () => {
  const src = sheet();
  expect(src).toContain('cron.runs(jobId)');
  expect(src).toContain('onOpenRun(run.id)');
  expect(src).toContain('setRunsError(');
});
