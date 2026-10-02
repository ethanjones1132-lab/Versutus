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

/** How long one backend gets in the scope-less sweep before it counts absent. */
const DEFAULT_SESSION_SEARCH_BOUND_MS = 8000;

/**
 * Ask a backend for one method, failing with a message the app can show.
 *
 * Resolution takes the caller's whole scope: `params.backendId` names an
 * environment, `params.bot` names a Bot and wins over it exactly as it does for
 * the REST routes. The method name is passed as well so a caller that named
 * neither still gets a backend that can serve it — a Gate with several
 * environments attached must not answer skills.list from whichever one happens
 * to be first.
 */
async function via(getBackend, params, name, call) {
  const backend = await getBackend(params?.backendId, params?.bot, name);
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
 * The create body behind `jobs.create` — the same `{ name, prompt, schedule }`
 * shape POST /v1/jobs takes and `ManifestClient.createJob` sends. Validated
 * here so a nameless or promptless create fails before any backend is picked,
 * mirroring the Routines pane's Add guard the Activity create form reuses.
 */
function jobInputOf(params) {
  const pick = (value) => (typeof value === 'string' ? value.trim() : '');
  const name = pick(params?.name ?? params?.title);
  const prompt = pick(params?.prompt);
  const schedule = pick(params?.schedule);
  if (!name) throw new Error('name is required');
  if (!prompt) throw new Error('prompt is required');
  if (!schedule) throw new Error('schedule is required');
  return { name, prompt, schedule };
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
 * The one refusal a session lookup makes, and the code that goes with it.
 *
 * `unknown_session` is what the app refuses a thread tap on, and it is only
 * ever right for a definite miss: a timeout, a 5xx or a host that is down is
 * propagated as itself, so the switch proceeds and the history read that
 * follows names the real failure.
 */
function unknownSession(sessionId) {
  return Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'unknown_session' });
}

/**
 * One exact-id read on one backend: `getSession` where the backend has it,
 * otherwise the Gate's own copy of that scope's list, and only then the wide
 * list scan. Returns the record or null for a definite miss; anything the
 * backend throws is the backend's own failure and travels untouched.
 *
 * The copy is a POSITIVE answer only. A backend that can read one id on its own
 * is asked directly — that read is authoritative and cheap, and a cached row can
 * be up to a refill old. An environment with no such read is the case the copy
 * exists for: listing 200 rows to find one id measured 3-38 s against a 6.2 GB
 * `state.db`, so the row the Gate already holds answers in microseconds, and a
 * miss still goes to the backend — the copy may be stale, and a session the
 * host has deleted must be reported gone.
 */
async function readOneSession(deps, scope, backend, sessionId) {
  if (typeof backend.getSession === 'function') return Promise.resolve(backend.getSession(sessionId));
  const cached = await deps.cachedSession(scope?.backendId, scope?.botId, sessionId);
  if (cached) return cached;
  if (typeof backend.listSessions !== 'function') {
    return Promise.reject(new Error("This gateway's backend cannot read sessions"));
  }
  return Promise.resolve(backend.listSessions(200)).then((sessions) => (
    (Array.isArray(sessions) ? sessions : []).find(
      (session) => session != null && String(session.id) === sessionId,
    ) ?? null
  ));
}

/**
 * The session behind one `{ backendId, botId }` scope, read and judged.
 *
 * A backend that refuses by name (`unknown_session`) is a definite miss — that
 * is the same word the Gate uses — while a timeout or a 5xx throws, so a slow
 * host can never retire a session the operator still has.
 */
async function readSessionInScope(deps, scope, sessionId) {
  const backend = await deps.getBackend(scope?.backendId, scope?.botId, 'listSessions');
  try {
    return (await readOneSession(deps, scope, backend, sessionId)) ?? null;
  } catch (error) {
    if (error?.code === 'unknown_session') return null;
    throw error;
  }
}

/** Stop offering a session the Gate's own copy still lists but nothing has. */
async function forgetSession(deps, scope, sessionId) {
  await deps.forgetSession?.(scope?.backendId, scope?.botId, sessionId);
}

/**
 * Ask every candidate scope at once and keep the first session that lands.
 *
 * Parallel because a scope-less read cannot afford a 3 s Hermes queued behind a
 * 3 s Claude Code; bounded per candidate because one environment that hangs must
 * not hold a tap hostage; first-hit-wins because a Gate with four environments
 * must not wait for the slowest of them. A candidate that errors or runs out of
 * time counts as "not here" — which is exactly what it is, for this lookup.
 */
function raceSessionReads(deps, scopes, sessionId) {
  return new Promise((resolve) => {
    let open = scopes.length;
    let settled = false;
    const finish = (found) => {
      if (settled) return;
      settled = true;
      resolve(found);
    };
    if (open === 0) {
      finish(null);
      return;
    }
    for (const scope of scopes) {
      const timer = setTimeout(() => miss(null), deps.sessionSearchBoundMs);
      timer.unref?.();
      readSessionInScope(deps, scope, sessionId).then(
        (found) => { clearTimeout(timer); miss(found); },
        () => { clearTimeout(timer); miss(null); },
      );
    }
    function miss(found) {
      open -= 1;
      if (found) finish(found);
      else if (open === 0) finish(null);
    }
  });
}

/**
 * The one shared exact-id lookup behind `session.get`, `session.usage`
 * and `session.restore`. Matches `id` exactly — never a substring.
 *
 * A scoped request is read from that scope and nowhere else, and a definite
 * miss there retires the row in the Gate's own copy (the Gate's index keyed it
 * to that environment and Bot, so a session upstream no longer has must stop
 * being offered by the next list).
 *
 * A request with NO scope at all is an older app build, and the id alone says
 * nothing about where it lives. Asking "the first backend that can list
 * sessions" answered `Session not found` for a Hermes thread the operator was
 * looking at, because Claude Code sorted first. So the Gate asks its own copy
 * which environment and Bot last listed this id, and only sweeps every
 * environment when nobody claims it.
 */
async function findSessionById(deps, params, sessionId) {
  if (params?.backendId || params?.bot) {
    const found = await readSessionInScope(deps, { backendId: params.backendId, botId: params.bot }, sessionId);
    if (found) return found;
    await forgetSession(deps, { backendId: params.backendId, botId: params.bot }, sessionId);
    throw unknownSession(sessionId);
  }
  for (const scope of await deps.sessionScopes(sessionId)) {
    let found = null;
    try {
      found = await readSessionInScope(deps, scope, sessionId);
    } catch {
      // A host that failed has NOT claimed the row is gone, so this scope
      // retires nothing; the sweep below still gets its turn at the id.
      continue;
    }
    if (found) return found;
    await forgetSession(deps, scope, sessionId);
  }
  const swept = await raceSessionReads(deps, await deps.allBackendScopes(), sessionId);
  if (swept) return swept;
  throw unknownSession(sessionId);
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
 * @param {(backendId?: string, botId?: string, method?: string) => Promise<object>} deps.getBackend
 *   Resolves the scope the caller's params name — a Bot wins over an
 *   environment, exactly as for the REST routes — or throws a named refusal.
 *   Unlike the routes' `resolveBackend`, this must not write to a response: the
 *   RPC dispatcher owns the reply.
 * @param {(sessionId: string) => Promise<Array<{ backendId?: string, botId?: string }>>} deps.sessionScopes
 *   The scopes whose Gate-held session lists contain this id, most recent first.
 * @param {(backendId?: string, botId?: string, sessionId: string) => Promise<object|null>} [deps.cachedSession]
 *   One session out of the Gate's own copy of that scope's list, or null. The
 *   copy answers an environment with no get-by-id read, which is the one whose
 *   wide catalogue read costs seconds.
 * @param {() => Promise<Array<{ backendId?: string }>>} deps.allBackendScopes
 *   Every attached environment, for the sweep a scope-less request falls back to.
 * @param {(backendId?: string, botId?: string, sessionId: string) => Promise<void>} deps.forgetSession
 *   Drops a confirmed miss from the Gate's own copy of that scope's list.
 * @param {number} [deps.sessionSearchBoundMs] Per-backend bound on the sweep.
 * @param {() => Promise<object[]>} [deps.listDevices]
 *   Devices that hold a token on this Gate. The store's `token` field stays
 *   in the store — this method never puts it on the wire.
 * @param {(deviceId: string) => Promise<boolean>} [deps.revokeDevice]
 *   Marks one device's token revoked. Returns true when an entry matched,
 *   false when no device is on file under that id.
 */
export function createGatewayMethods({
  getBackend,
  sessionScopes,
  allBackendScopes,
  forgetSession: forget,
  cachedSession,
  sessionSearchBoundMs = DEFAULT_SESSION_SEARCH_BOUND_MS,
  listDevices,
  revokeDevice,
}) {
  const deps = {
    getBackend,
    forgetSession: forget,
    sessionScopes: typeof sessionScopes === 'function' ? sessionScopes : async () => [],
    allBackendScopes: typeof allBackendScopes === 'function' ? allBackendScopes : async () => [],
    cachedSession: typeof cachedSession === 'function' ? cachedSession : async () => null,
    sessionSearchBoundMs,
  };

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

    /**
     * Revoke one paired device's token. Answers `{ deviceId, revoked }` with
     * public fields only — the token itself is never read, let alone sent.
     * An unknown id throws, mirroring the host CLI's `pair revoke` copy, so
     * the caller's honest-failure path renders it instead of a silent no-op.
     */
    'device.revoke': async (params) => {
      if (typeof revokeDevice !== 'function') {
        throw new Error('This gateway does not keep a device registry');
      }
      const raw = params?.deviceId ?? params?.device ?? params?.id;
      const deviceId = typeof raw === 'string' ? raw.trim() : '';
      if (!deviceId) {
        throw new Error('deviceId is required');
      }
      const revoked = await revokeDevice(deviceId);
      if (!revoked) {
        throw new Error(`No device "${deviceId}" on file.`);
      }
      return { deviceId, revoked: true };
    },

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
        // Same key list formatCron and ManifestClient.listJobs read
        // (['data', 'jobs', 'crons', 'items']): a host answering
        // { crons: [...] } must not read as empty in the Activity tab.
        const jobs = (raw?.data ?? raw?.jobs ?? raw?.crons ?? raw?.items ?? (Array.isArray(raw) ? raw : []))
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
    'jobs.create': (params) => via(getBackend, params, 'createJob', (b) => b.createJob(jobInputOf(params))),
    'jobs.remove': (params) => via(getBackend, params, 'removeJob', (b) => b.removeJob(jobIdOf(params))),

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

    // One shared exact-id lookup behind the session read RPCs. A backend that
    // has getSession is asked for the id alone — the wide catalogue page is the
    // fallback for the ones that do not, and stays wide on purpose (the Hermes
    // default-page note on listSessions above, and the cron.runs comment).
    'session.get': async (params) =>
      findSessionById(deps, params, requiredSessionId(params)),

    // With an id this reports that session's token/cost counters; without
    // one it totals the whole catalogue, so the bare `/session usage`
    // answers instead of demanding an id.
    'session.usage': async (params) => {
      const raw = params?.sessionId ?? params?.id;
      if (raw) return usageOf(await findSessionById(deps, params, String(raw)));
      const sessions = await via(getBackend, params, 'listSessions', (b) => b.listSessions(200));
      const list = Array.isArray(sessions) ? sessions : [];
      const totals = { sessions: list.length };
      for (const field of USAGE_COUNTER_FIELDS) {
        totals[field] = list.reduce((sum, s) => sum + (Number(s?.[field]) || 0), 0);
      }
      return totals;
    },

    // The lookup behind `/session restore <id>` and the thread-sheet tap.
    // Returns the record; the app switches its open thread only after this
    // resolves, so a missing id never moves local history — and so does the
    // scope the app sent, which is the whole reason a session the operator
    // could see no longer opened.
    'session.restore': async (params) =>
      findSessionById(deps, params, requiredSessionId(params)),

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

    // P2: one Bot's memory files, read on demand like its soul. The backend
    // owns which files are memory; an unknown Bot or a backend without the
    // read fails honestly instead of returning an empty memory.
    'bots.memory': (params) => via(getBackend, params, 'getBotMemory', (b) => b.getBotMemory({ id: params?.id })),

    // P2: write one whitelisted memory file. The phone confirms first; the
    // backend/reader still refuses any name that is not memory.
    'bots.memory.write': (params) =>
      via(getBackend, params, 'setBotMemory', (b) =>
        b.setBotMemory({ id: params?.id, name: params?.name, text: params?.text }),
      ),
  };
}
