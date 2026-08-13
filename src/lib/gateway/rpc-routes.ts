// ─── Hermes API route map (pure, node-testable) ───────────────────
// Maps RPC-style method names (the slash-command registry dialect) onto
// the Hermes API server's REST surface. Endpoints are evidence-based:
// https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
// Methods without a Hermes equivalent are deliberately absent — the
// client reports them as unsupported rather than guessing.

export type Route = { method: string; path: string };

export const METHOD_TO_ROUTE: Record<string, Route> = {
  // Health & status
  'health': { method: 'GET', path: '/health' },
  'status': { method: 'GET', path: '/health/detailed' },
  'diagnostics.full': { method: 'GET', path: '/health/detailed' },
  // Models
  'models.list': { method: 'GET', path: '/v1/models' },
  // Sessions (Sessions API)
  'sessions.list': { method: 'GET', path: '/api/sessions' },
  'sessions.current': { method: 'GET', path: '/api/sessions' },
  'session.get': { method: 'GET', path: '/api/sessions/{sessionId}' },
  'session.messages': { method: 'GET', path: '/api/sessions/{sessionId}/messages' },
  'session.usage': { method: 'GET', path: '/api/sessions/{sessionId}' },
  'session.restore': { method: 'GET', path: '/api/sessions/{sessionId}' },
  'session.fork': { method: 'POST', path: '/api/sessions/{sessionId}/fork' },
  'session.chat': { method: 'POST', path: '/api/sessions/{sessionId}/chat' },
  'session.chat.stream': { method: 'POST', path: '/api/sessions/{sessionId}/chat/stream' },
  // Runs & responses
  'responses.get': { method: 'GET', path: '/v1/responses/{responseId}' },
  'responses.delete': { method: 'DELETE', path: '/v1/responses/{responseId}' },
  'runs.create': { method: 'POST', path: '/v1/runs' },
  // Cron (Jobs API)
  'cron.list': { method: 'GET', path: '/api/jobs' },
  'cron.status': { method: 'GET', path: '/api/jobs' },
  'jobs.run': { method: 'POST', path: '/api/jobs/{jobId}/run' },
  // Skills & tools
  'skills.list': { method: 'GET', path: '/v1/skills' },
  'skills.status': { method: 'GET', path: '/v1/skills' },
  'tools.list': { method: 'GET', path: '/v1/toolsets' },
  // Capabilities
  'capabilities': { method: 'GET', path: '/v1/capabilities' },
};

/**
 * Actionable guidance for RPC methods the Hermes API server does not
 * expose (verified against the official docs). Surfaced in the
 * unsupported-method error so slash commands answer with a next step
 * instead of a bare failure.
 */
export const METHOD_GUIDANCE: Record<string, string> = {
  'agents.list': 'Hermes has no remote agent registry — agents are profiles. Multi-profile gateways expose each profile at /p/<profile>/; add that URL as its own gateway with the profile API key.',
  'agent.get': 'Hermes has no remote agent registry — agents are profiles. See agents.list guidance.',
  'approvals.pending': 'Hermes run approvals are resolved via POST /v1/runs/{run_id}/approval; there is no remote pending-approval list. Approve from the app when a run requests it.',
  'approval.approve': 'Hermes resolves run approvals via POST /v1/runs/{run_id}/approval — approve from the app when the run requests it.',
  'approval.deny': 'Hermes resolves run approvals via POST /v1/runs/{run_id}/approval — deny from the app when the run requests it.',
  'exec.approvals': 'Hermes run approvals are per-run (POST /v1/runs/{run_id}/approval); no exec-approval list is exposed.',
  'exec.approvals.get': 'Hermes run approvals are per-run (POST /v1/runs/{run_id}/approval); no exec-approval list is exposed.',
  'artifacts.list': 'Hermes does not expose artifact storage over the API server. Ask the agent to write files to a retrievable path, or use the terminal.',
  'artifact.get': 'Hermes does not expose artifact storage over the API server — use the terminal to read files.',
  'channels.status': 'Hermes messaging channels are configured on the gateway host (config.yaml / hermes CLI) — no remote channel admin REST exists.',
  'channel.start': 'Hermes messaging channels are host-configured — start them on the gateway (hermes gateway channels).',
  'channel.stop': 'Hermes messaging channels are host-configured — stop them on the gateway (hermes gateway channels).',
  'channel.logout': 'Hermes messaging channels are host-configured — manage sessions on the gateway host.',
  'config.get': 'Hermes configuration lives in ~/.hermes/config.yaml on the gateway host — the API server exposes no config REST. Use the Chat model picker for per-request model selection.',
  'config.patch': 'Hermes configuration is host-side (config.yaml) — no remote config writes exist. Per-request model override is the supported path (model picker).',
  'config.schema': 'Hermes config schema is host-side — no remote schema REST exists.',
  'config.diff': 'Hermes configuration is host-side — no remote config REST exists.',
  'config.rollback': 'Hermes configuration is host-side — no remote config REST exists.',
  'cron.history': 'The Hermes Jobs API (GET /api/jobs) exposes jobs and last-run state but no per-job run history.',
  'device.info': 'Versutus devices pair via signed access requests; Hermes has no device registry REST.',
  'device.repair': 'Versutus devices pair via signed access requests; Hermes has no device registry REST.',
  'device.revoke': 'Versutus devices pair via signed access requests; Hermes has no device registry REST.',
  'diagnostics.stability': 'Use /diagnostics (GET /health/detailed) for the readiness snapshot.',
  'doctor.memory': 'Memory lives on the gateway host; the API server only scopes it via the X-Hermes-Session-Key header.',
  'doctor.memory.status': 'Memory lives on the gateway host; the API server only scopes it via the X-Hermes-Session-Key header.',
  'env.get': 'Environment and secrets management is host-side (config.yaml) — no remote REST exists.',
  'environments.list': 'Environment and secrets management is host-side — no remote REST exists.',
  'environments.status': 'Environment and secrets management is host-side — no remote REST exists.',
  'logs.tail': 'Gateway logs are host-side (hermes logs) — the API server does not expose log streaming.',
  'models.primary': 'Model routing is host config. Per-request model override is supported — use the Chat model picker.',
  'models.authStatus': 'Model auth status rides the model catalog (GET /v1/models) where the gateway reports it; provider keys themselves are host-side.',
  'models.routing': 'Model routing is host config. Per-request model override is supported — use the Chat model picker.',
  'routing.models': 'Model routing is host config. Per-request model override is supported — use the Chat model picker.',
  'plugin.get': 'Plugins are host-managed; the API server exposes toolsets (/tools) but not plugin management.',
  'plugins.list': 'Plugins are host-managed; the API server exposes toolsets (/tools) but not plugin management.',
  'plugins.uiDescriptors': 'Plugins are host-managed; the API server exposes no plugin UI descriptors.',
  'session.abort': 'Aborting a Hermes run: the app stop button aborts the stream; server-side stop exists per run via POST /v1/runs/{run_id}/stop.',
  'session.compact': 'No remote compaction endpoint — start a new session (POST /api/sessions) or use the session selector.',
  'skill.get': 'Skills are enumerated via GET /v1/skills; per-skill detail is host-side.',
  'talk.catalog': 'Voice is host-side; the API server exposes no voice REST.',
  'voicewake.status': 'Voice is host-side; the API server exposes no voice REST.',
  'tools.effective': 'Use /tools for the toolsets catalog (GET /v1/toolsets).',
  'tools.profile': 'Use /tools for the toolsets catalog (GET /v1/toolsets).',
  'usage.cost': 'Session records carry token/cost fields — see /sessions and /session usage <id>.',
  'usage.status': 'Session records carry token/cost fields — see /sessions and /session usage <id>.',
};

/**
 * Resolve a method to a concrete HTTP request: interpolates {param}
 * path placeholders from params, moves the rest into the query string
 * for GET, and leaves the remainder as the JSON body for other verbs.
 */
export function resolveRoute(
  method: string,
  params: Record<string, unknown> = {},
): { route: Route; path: string; body: Record<string, unknown> } | null {
  const route = METHOD_TO_ROUTE[method];
  if (!route) return null;

  let path = route.path;
  const query: string[] = [];
  const body: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const placeholder = `{${key}}`;
    if (path.includes(placeholder)) {
      path = path.replace(placeholder, encodeURIComponent(String(value)));
    } else if (route.method === 'GET') {
      query.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    } else {
      body[key] = value;
    }
  }
  if (query.length > 0) path += `?${query.join('&')}`;

  return { route, path, body };
}
