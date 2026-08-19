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
  const backend = await getBackend(params?.backendId);
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

    'cron.list': (params) => via(getBackend, params, 'listJobs', (b) => b.listJobs()),
    'cron.status': (params) => via(getBackend, params, 'listJobs', (b) => b.listJobs()),
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
  };
}
