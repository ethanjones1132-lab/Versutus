import { createRoutineScheduler } from './index.mjs';

export const SCHEDULED_ADAPTERS = new Set(['claude-code', 'codex', 'opencode']);

/**
 * Owns Gate-scheduled routines without coupling them to backend startup.
 * Scheduler instances are keyed by environment and Bot, matching the on-disk
 * namespace used by createRoutineScheduler.
 */
export function createRoutineRegistry({
  directory,
  listEnvironments,
  getBackend,
  runTurn,
  now = () => Date.now(),
  setTimer = setTimeout,
} = {}) {
  if (!directory) throw new Error('Routine registry requires a directory');
  if (typeof listEnvironments !== 'function') throw new Error('Routine registry requires listEnvironments');
  if (typeof getBackend !== 'function') throw new Error('Routine registry requires getBackend');
  if (typeof runTurn !== 'function') throw new Error('Routine registry requires runTurn');

  const schedulers = new Map();
  let running = false;
  let startPromise = null;

  async function environment(environmentId) {
    const environments = await listEnvironments();
    return environments.find((record) => record?.id === environmentId) ?? null;
  }

  async function isScheduled(environmentId) {
    const record = await environment(environmentId);
    return Boolean(record && SCHEDULED_ADAPTERS.has(record.adapterId));
  }

  async function forEnvironment(environmentId, botId = null) {
    const record = await environment(environmentId);
    if (!record || !SCHEDULED_ADAPTERS.has(record.adapterId)) return null;
    const normalizedBotId = botId ?? null;
    const key = JSON.stringify([environmentId, normalizedBotId]);
    let entry = schedulers.get(key);
    if (!entry) {
      const scheduler = createRoutineScheduler({
        directory,
        environmentId,
        botId: normalizedBotId,
        now,
        setTimer,
        execute: async (job, context) => {
          // Starting a backend belongs to a fired job, never to registry
          // discovery, scheduler construction, or a routine management read.
          const environmentBackend = await getBackend(environmentId);
          const backend = normalizedBotId && typeof environmentBackend?.forBot === 'function'
            ? await environmentBackend.forBot(normalizedBotId)
            : environmentBackend;
          if (typeof backend?.createSession !== 'function') {
            throw new Error('Backend cannot create sessions for routines');
          }
          const created = await backend.createSession({
            title: `${job.name} · ${new Date(now()).toISOString().slice(0, 10)}`,
            ...(normalizedBotId ? { botId: normalizedBotId } : {}),
          });
          const sessionId = typeof created === 'string' ? created : created?.id ?? created?.sessionId;
          if (!sessionId) throw new Error('Backend did not return a routine session id');
          return runTurn(backend, String(sessionId), job.prompt, {
            ...context,
            environmentId,
            botId: normalizedBotId,
            job,
          });
        },
      });
      entry = { scheduler, started: false, startPromise: null };
      schedulers.set(key, entry);
    }
    if (running && !entry.started) {
      entry.started = true;
      entry.startPromise = entry.scheduler.start();
    }
    if (entry.startPromise) await entry.startPromise;
    return entry.scheduler;
  }

  async function startAll() {
    if (startPromise) return startPromise;
    running = true;
    startPromise = (async () => {
      const environments = await listEnvironments();
      for (const record of environments) {
        if (!record || !SCHEDULED_ADAPTERS.has(record.adapterId)) continue;
        const scheduler = await forEnvironment(record.id);
        const entry = schedulers.get(JSON.stringify([record.id, null]));
        if (scheduler && entry && !entry.started) {
          entry.started = true;
          entry.startPromise = scheduler.start();
          await entry.startPromise;
        }
      }
    })().catch((error) => {
      startPromise = null;
      throw error;
    });
    return startPromise;
  }

  async function stopAll() {
    running = false;
    for (const entry of schedulers.values()) {
      entry.scheduler.stop();
      entry.started = false;
      entry.startPromise = null;
    }
    startPromise = null;
  }

  return { isScheduled, forEnvironment, startAll, stopAll };
}
