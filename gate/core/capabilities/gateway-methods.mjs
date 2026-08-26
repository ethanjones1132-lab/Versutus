import {
  parseCronSessionId,
  runsForJob,
  toCronJobView,
  toCronTurn,
} from '../cron-view.mjs';

/**
 * Hermes-dialect RPC methods, answered by the Gate itself.
 *
 * The app's slash-command registry speaks one dialect: it POSTs `skills.list`,
 * `cron.list`, `tools.list` … to `/v1/capabilities/rpc`. The Gate dispatched
 * only `registry.*`, `providers.*` and `environment*`, so every one of those
 * came back `Unknown method "tools.list"` — which is why the app resorted to
 * dropping all rpc-transport commands for non-Hermes gateways by kind.
 *
 * These implementations sit on the same backend passthroughs the REST routes
 * use, so "advertised" and "dispatchable" cannot drift: one mechanism, not two.
 */

/** Ask a backend for one method, failing with a message the app can show. */
async function via(getBackend, params, name, call) {
  // The method name is passed so the resolver can pick a backend that
  // implements it — a Gate with several environments attached must not answer
  // skills.list from whichever one happens to be first.
  const backend = await getBackend(params?.backendId, name);
  if (typeof backend?.[name] !== 'function') {
    throw new Error(`This gateway's backend does not implement ${name}`);
  }
  return call(backend);
}

function jobIdOf(params) {
  const id = params?.jobId ?? params?.job_id ?? params?.id;
  if (!id) throw new Error('jobId is required');
  return String(id);
}

/**
 * @param {object} deps
 * @param {(backendId?: string) => Promise<object>} deps.getBackend
 *   Resolves the backend or throws. Unlike the routes' `resolveBackend`, this
 *   must not write to a response — the RPC dispatcher owns the reply.
 */
export function createGatewayMethods({ getBackend }) {
  return {
    // The Gate answers for itself; no backend required.
    health: async () => ({ status: 'ok', timestamp: new Date().toISOString() }),

    status: (params) => via(getBackend, params, 'healthDetailed', (b) => b.healthDetailed()),
    'diagnostics.full': (params) => via(getBackend, params, 'healthDetailed', (b) => b.healthDetailed()),

    'skills.list': (params) => via(getBackend, params, 'listSkills', (b) => b.listSkills()),
    'skills.status': (params) => via(getBackend, params, 'listSkills', (b) => b.listSkills()),

    // Hermes-dialect passthroughs the slash-command registry speaks. Left raw
    // on purpose: `/cron` renders whatever the host returns.
    'cron.list': (params) => via(getBackend, params, 'listJobs', (b) => b.listJobs()),
    'cron.status': (params) => via(getBackend, params, 'listJobs', (b) => b.listJobs()),

    // ── Cron transparency ────────────────────────────────────────────
    // The curated surfaces. `cron.list` above answers the dialect; these
    // answer the operator's questions — what is this job, did it work, what
    // is it doing right now — by joining the job record, its latest
    // execution, and the sessions its runs wrote. The
    // `cron_<jobId>_<ts>` naming that links them is a HOST convention and
    // stays here, so the phone never learns how Hermes spells a session id.
    'cron.jobs': async (params) =>
      via(getBackend, params, 'listJobs', async (backend) => {
        const raw = await backend.listJobs();
        const jobs = (raw?.data ?? raw?.jobs ?? (Array.isArray(raw) ? raw : []))
          .map(toCronJobView)
          .filter(Boolean);
        return { object: 'list', data: jobs };
      }),

    'cron.runs': async (params) => {
      const jobId = jobIdOf(params);
      // Resolve on the CRON capability, not on listSessions. Every backend can
      // list sessions — Claude Code sorts first and answers with its own
      // transcripts, which contain no cron runs at all. The environment that
      // owns the jobs is the only one whose sessions can hold their runs.
      return via(getBackend, params, 'listJobs', async (backend) => {
        if (typeof backend.listSessions !== 'function') {
          throw new Error(`This gateway's cron backend cannot list sessions, so run history is unavailable`);
        }
        // Ask wide: runs are interleaved with every other session on the
        // host, so a small page would silently hide older runs.
        const sessions = await backend.listSessions(Number(params?.limit) || 200);
        return { object: 'list', data: runsForJob(jobId, sessions ?? []) };
      });
    },

    /** Read-only transcript of one run. `runId` is the run's session id. */
    'cron.transcript': async (params) => {
      const runId = params?.runId ?? params?.run_id ?? params?.sessionId;
      if (!runId) throw new Error('runId is required');
      if (!parseCronSessionId(runId)) {
        throw new Error(`"${runId}" is not a cron run id`);
      }
      // Same reasoning as cron.runs: the transcript lives on the environment
      // that ran the job, not on whichever one lists messages first.
      return via(getBackend, params, 'listJobs', async (backend) => {
        if (typeof backend.listMessages !== 'function') {
          throw new Error(`This gateway's cron backend cannot read transcripts`);
        }
        const messages = await backend.listMessages(String(runId), Number(params?.limit) || undefined);
        return { object: 'list', data: (messages ?? []).map(toCronTurn).filter(Boolean) };
      });
    },
    'jobs.run': (params) => via(getBackend, params, 'runJob', (b) => b.runJob(jobIdOf(params))),
    'jobs.pause': (params) => via(getBackend, params, 'setJobPaused', (b) => b.setJobPaused(jobIdOf(params), true)),
    'jobs.resume': (params) => via(getBackend, params, 'setJobPaused', (b) => b.setJobPaused(jobIdOf(params), false)),

    'sessions.list': async (params) =>
      via(getBackend, params, 'listSessions', async (b) => ({ object: 'list', data: await b.listSessions() })),

    // Backend models only, matching what `models.list` returns on Hermes. The
    // Gate's merged provider+backend catalog stays at GET /v1/models, which is
    // what the app's Models tab reads.
    'models.list': async (params) =>
      via(getBackend, params, 'listModels', async (b) => ({ object: 'list', data: await b.listModels() })),

    'tools.list': (params) => via(getBackend, params, 'listToolsets', (b) => b.listToolsets()),

    'bots.list': (params) => via(getBackend, params, 'listBots', (b) => b.listBots()),
  };
}
