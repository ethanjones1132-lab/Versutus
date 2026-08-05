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
  'model.options': { method: 'GET', path: '/api/model/options' },
  // Sessions (Sessions API)
  'sessions.list': { method: 'GET', path: '/api/sessions' },
  'sessions.current': { method: 'GET', path: '/api/sessions' },
  'session.get': { method: 'GET', path: '/api/sessions/{sessionId}' },
  'session.messages': { method: 'GET', path: '/api/sessions/{sessionId}/messages' },
  'session.usage': { method: 'GET', path: '/api/sessions/{sessionId}' },
  'session.restore': { method: 'GET', path: '/api/sessions/{sessionId}' },
  // Cron (Jobs API)
  'cron.list': { method: 'GET', path: '/api/jobs' },
  'cron.status': { method: 'GET', path: '/api/jobs' },
  // Skills & tools
  'skills.list': { method: 'GET', path: '/v1/skills' },
  'skills.status': { method: 'GET', path: '/v1/skills' },
  'tools.list': { method: 'GET', path: '/v1/toolsets' },
  // Capabilities
  'capabilities': { method: 'GET', path: '/v1/capabilities' },
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
