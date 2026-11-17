import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJsonFile, writeFileAtomic } from '../atomic-file.mjs';
import { nextCronRun } from './cron.mjs';

const HISTORY_LIMIT = 50;
const TICK_MS = 15_000;
const RUN_TIMEOUT_MS = 10 * 60_000;

function fileFor(directory, environmentId, botId) {
  const scope = JSON.stringify([environmentId, botId ?? null]);
  const digest = createHash('sha256').update(scope).digest('hex');
  return join(directory, `${digest}.json`);
}

function validateSchedule(schedule) {
  nextCronRun(schedule, new Date());
}

/**
 * Gate-owned cron storage and runner, scoped to one environment/Bot pair.
 * `execute` receives a routine and `{ catchUp }`; `now` and timer functions are
 * injectable so callers can drive scheduling deterministically in tests.
 */
export function createRoutineScheduler({
  directory,
  environmentId,
  botId = null,
  execute,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  tickMs = TICK_MS,
  runTimeoutMs = RUN_TIMEOUT_MS,
} = {}) {
  if (!directory || !environmentId) throw new Error('Routine scheduler requires a directory and environmentId');
  if (typeof execute !== 'function') throw new Error('Routine scheduler requires an execute function');
  const path = fileFor(directory, environmentId, botId);
  let jobs = null;
  let timer = null;
  let stopped = false;
  let queue = Promise.resolve();

  async function load() {
    if (jobs) return;
    await mkdir(directory, { recursive: true });
    const result = await readJsonFile(path);
    if (result.state === 'corrupt') throw result.error;
    jobs = result.state === 'ok' && Array.isArray(result.value?.jobs) ? result.value.jobs : [];
    // Restart recomputes missed schedules from now; overdue jobs run once only.
    for (const job of jobs) {
      if (!job.enabled) continue;
      const previous = Date.parse(job.next_run_at);
      if (!Number.isFinite(previous) || previous <= now()) {
        job.catch_up_pending = Number.isFinite(previous) && previous > 0;
        job.next_run_at = new Date(now()).toISOString();
      }
    }
    await save();
  }

  async function save() {
    await writeFileAtomic(path, `${JSON.stringify({ jobs }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  function serialize(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }

  async function listJobs() {
    await load();
    return { jobs: structuredClone(jobs) };
  }

  async function createJob(input = {}) {
    const name = String(input.name ?? '').trim();
    const prompt = String(input.prompt ?? '').trim();
    const schedule = String(input.schedule ?? '').trim();
    if (!name) throw new Error('name is required');
    if (!prompt) throw new Error('prompt is required');
    if (!schedule) throw new Error('schedule is required');
    validateSchedule(schedule);
    return serialize(async () => {
      await load();
      const job = {
        id: randomUUID().replaceAll('-', ''),
        name,
        prompt,
        schedule,
        enabled: true,
        paused: false,
        next_run_at: nextCronRun(schedule, new Date(now())).toISOString(),
        last_run_at: null,
        last_status: null,
        history: [],
      };
      jobs.push(job);
      await save();
      return structuredClone(job);
    });
  }

  async function updateJob(jobId, update = {}) {
    return serialize(async () => {
      await load();
      const job = jobs.find((row) => row.id === String(jobId));
      if (!job) throw new Error(`Routine "${jobId}" was not found`);
      const name = update.name === undefined ? job.name : String(update.name).trim();
      const prompt = update.prompt === undefined ? job.prompt : String(update.prompt).trim();
      const schedule = update.schedule === undefined ? job.schedule : String(update.schedule).trim();
      if (!name || !prompt || !schedule) throw new Error('name, prompt and schedule are required');
      validateSchedule(schedule);
      Object.assign(job, { name, prompt, schedule });
      job.next_run_at = nextCronRun(schedule, new Date(now())).toISOString();
      await save();
      return structuredClone(job);
    });
  }

  async function setJobPaused(jobId, paused) {
    return serialize(async () => {
      await load();
      const job = jobs.find((row) => row.id === String(jobId));
      if (!job) throw new Error(`Routine "${jobId}" was not found`);
      job.enabled = !paused;
      job.paused = Boolean(paused);
      delete job.catch_up_pending;
      job.next_run_at = paused ? null : nextCronRun(job.schedule, new Date(now())).toISOString();
      await save();
      return structuredClone(job);
    });
  }

  async function removeJob(jobId) {
    return serialize(async () => {
      await load();
      const index = jobs.findIndex((row) => row.id === String(jobId));
      if (index < 0) throw new Error(`Routine "${jobId}" was not found`);
      jobs.splice(index, 1);
      await save();
      return { removed: true };
    });
  }

  async function runJob(jobId, { catchUp = false } = {}) {
    await load();
    const job = jobs.find((row) => row.id === String(jobId));
    if (!job) throw new Error(`Routine "${jobId}" was not found`);
    const started = now();
    const timestamp = new Date(started);
    const stamp = `${timestamp.getFullYear()}${String(timestamp.getMonth() + 1).padStart(2, '0')}${String(timestamp.getDate()).padStart(2, '0')}_${String(timestamp.getHours()).padStart(2, '0')}${String(timestamp.getMinutes()).padStart(2, '0')}${String(timestamp.getSeconds()).padStart(2, '0')}`;
    const runId = `cron_${job.id}_${stamp}`;
    let result;
    let timeout;
    try {
      result = await Promise.race([
        execute(structuredClone(job), { catchUp, runId }),
        new Promise((_, reject) => {
          timeout = setTimer(() => reject(new Error('Routine run timed out')), runTimeoutMs);
          timeout?.unref?.();
        }),
      ]);
      job.history.unshift({
        id: runId,
        started_at: new Date(started).toISOString(),
        finished_at: new Date(now()).toISOString(),
        status: 'ok',
        output: String(result?.output ?? ''),
        duration_ms: Math.max(0, now() - started),
        ...(catchUp ? { catch_up: true } : {}),
      });
      job.last_status = 'ok';
    } catch (error) {
      job.history.unshift({
        id: runId,
        started_at: new Date(started).toISOString(),
        finished_at: new Date(now()).toISOString(),
        status: 'error',
        output: String(error?.message ?? error),
        error: String(error?.message ?? error),
        duration_ms: Math.max(0, now() - started),
        ...(catchUp ? { catch_up: true } : {}),
      });
      job.last_status = 'error';
    } finally {
      if (timeout) clearTimer(timeout);
      job.last_run_at = new Date(now()).toISOString();
      delete job.catch_up_pending;
      job.history = job.history.slice(0, HISTORY_LIMIT);
      if (job.enabled) job.next_run_at = nextCronRun(job.schedule, new Date(now())).toISOString();
      await serialize(save);
    }
    return structuredClone(job.history[0]);
  }

  async function tick() {
    await load();
    const due = jobs.filter((job) => job.enabled && Date.parse(job.next_run_at) <= now());
    for (const job of due) await runJob(job.id, { catchUp: job.catch_up_pending === true });
  }

  function scheduleTick() {
    if (stopped) return;
    timer = setTimer(() => {
      tick().catch(() => {}).finally(scheduleTick);
    }, tickMs);
    timer?.unref?.();
  }

  async function start() {
    stopped = false;
    await load();
    await tick();
    scheduleTick();
  }

  function stop() {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
  }

  return { listJobs, createJob, updateJob, setJobPaused, removeJob, runJob, start, stop, tick };
}
