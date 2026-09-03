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

/** Counters a session record carries; summed for the catalogue-wide usage. */
const USAGE_COUNTER_FIELDS = [
  'message_count',
  'tool_call_count',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'reasoning_tokens',
  'api_call_count',
];

function requiredSessionId(params) {
  const id = params?.sessionId ?? params?.id;
  if (!id) throw new Error('sessionId is required');
  return String(id);
}

/**
 * The one shared exact-id lookup behind `session.get`, `session.usage`
 * and `session.restore`. Matches `id` exactly — never a substring — and
 * throws a named failure for an absent id so the app can print it instead
 * of an empty read.
 */
async function findSessionById(getBackend, params, sessionId) {
  const sessions = await via(getBackend, params, 'listSessions', (b) => b.listSessions(200));
  const match = (Array.isArray(sessions) ? sessions : []).find(
    (session) => session != null && String(session.id) === sessionId,
  );
  if (!match) throw new Error(`Session not found: ${sessionId}`);
  return match;
}

/** The token/cost counters of one session record, in its own envelope. */
function usageOf(session) {
  const usage = { sessionId: session?.id ?? null };
  for (const field of USAGE_COUNTER_FIELDS) {
    usage[field] = Number(session?.[field]) || 0;
  }
  usage.estimated_cost_usd = session?.estimated_cost_usd ?? null;
  usage.actual_cost_usd = session?.actual_cost_usd ?? null;
  return usage;
}

/**
 * @param {object} deps
 * @param {(backendId?: string) => Promise<object>} deps.getBackend
 *   Resolves the backend or throws. Unlike the routes' `resolveBackend`, this
 *   must not write to a response — the RPC dispatcher owns the reply.
 * @param {() => Promise<object[]>} [deps.listDevices]
 *   Devices that hold a token on this Gate. The store's `token` field stays
 *   in the store — this method never puts it on the wire.
 */
export function createGatewayMethods({ getBackend, listDevices }) {
  return {
    // The Gate answers for itself; no backend required.
    health: async () => ({ status: 'ok', timestamp: new Date().toISOString() }),

    /**
     * Devices that hold a token on this Gate. Public fields only:
     * deviceId, role, scopes, issuedAtMs, revoked. Never `token`.
     */
    'device.list': async () => {
      if (typeof listDevices !== 'function') {
        throw new Error('This gateway does not keep a device registry');
      }
      const entries = await listDevices();
      const list = Array.isArray(entries) ? entries : [];
      return {
        devices: list.map((entry) => ({
          deviceId: entry?.deviceId,
          role: entry?.role,
          scopes: Array.isArray(entry?.scopes) ? entry.scopes : [],
          issuedAtMs: entry?.issuedAtMs,
          revoked: Boolean(entry?.revoked),
        })),
      };
    },

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
      via(getBackend, params, 'listSessions', async (b) => ({
        object: 'list',
        // The limit must travel: without it Hermes serves its default page
        // and anything past that window reads as absent. Absent stays
        // undefined so the backend keeps its default.
        data: await b.listSessions(Number(params?.limit) || undefined),
      })),

    // The transcript reader behind `/session messages <id>`. The REST route
    // already serves it at GET /v1/sessions/{id}/messages, but the app's
    // command path speaks RPC (`session.messages`), which answered
    // `Unknown method` here. Same backend method, same normalized list
    // envelope, with the requested limit travelling to the backend.
    'session.messages': async (params) => {
      const sessionId = params?.sessionId ?? params?.id;
      if (!sessionId) throw new Error('sessionId is required');
      return via(getBackend, params, 'listMessages', async (b) => ({
        object: 'list',
        data: await b.listMessages(String(sessionId), Number(params?.limit) || undefined),
      }));
    },

    // One shared exact-id lookup behind the session read RPCs. No backend
    // offers a get-by-id call, so all three read the same wide catalogue
    // page and match the id exactly. Wide on purpose: a small page would
    // silently hide older sessions (the Hermes default-page note on
    // listSessions above, and the cron.runs comment), and an absent id
    // fails honestly instead of reading as empty.
    'session.get': async (params) =>
      findSessionById(getBackend, params, requiredSessionId(params)),

    // With an id this reports that session's token/cost counters; without
    // one it totals the whole catalogue, so the bare `/session usage`
    // answers instead of demanding an id.
    'session.usage': async (params) => {
      const raw = params?.sessionId ?? params?.id;
      if (raw) return usageOf(await findSessionById(getBackend, params, String(raw)));
      const sessions = await via(getBackend, params, 'listSessions', (b) => b.listSessions(200));
      const list = Array.isArray(sessions) ? sessions : [];
      const totals = { sessions: list.length };
      for (const field of USAGE_COUNTER_FIELDS) {
        totals[field] = list.reduce((sum, s) => sum + (Number(s?.[field]) || 0), 0);
      }
      return totals;
    },

    // The lookup behind `/session restore <id>`. Returns the record; the
    // app switches its open thread only after this resolves, so a missing
    // id never moves local history.
    'session.restore': async (params) =>
      findSessionById(getBackend, params, requiredSessionId(params)),

    // Backend models only, matching what `models.list` returns on Hermes. The
    // Gate's merged provider+backend catalog stays at GET /v1/models, which is
    // what the app's Models tab reads.
    'models.list': async (params) =>
      via(getBackend, params, 'listModels', async (b) => ({ object: 'list', data: await b.listModels() })),

    'tools.list': (params) => via(getBackend, params, 'listToolsets', (b) => b.listToolsets()),

    'bots.list': (params) => via(getBackend, params, 'listBots', (b) => b.listBots()),

    // One Bot, with its soul. Separate from bots.list on purpose: the roster is
    // re-read constantly and a soul can be long, so it is fetched only when a
    // Bot is opened.
    'bots.get': (params) => via(getBackend, params, 'getBot', (b) => b.getBot({ id: params?.id })),
  };
}
