// ─── Telling "unsupported" apart from "not answering" ─────────────────────
// A route that needs a backend method walks the attached backends and asks each
// one to start. A backend that fails to start used to be swallowed as if it had
// simply lacked the method, so the answer was always 501 "No attached backend
// implements <method>". On 2026-09-16 Hermes' own gateway was stuck in a startup
// loop and the Gate could not reach :8642 — the app showed "No attached backend
// implements listBots", a claim about capability when the truth was an outage,
// and the diagnosis went the wrong way for an hour.
//
// If any backend failed to start, the Gate cannot know the method is
// unsupported: one of the silent backends may implement it. That is a 503 that
// names the backend and its reason. Only when every backend answered and none
// implements the method is 501 true.

const MAX_REASON = 200;

function reasonOf(error) {
  const raw = error instanceof Error ? error.message : String(error ?? 'unknown error');
  const redacted = raw.replace(/(Bearer\s+)\S+/gi, '$1[redacted]');
  return redacted.length > MAX_REASON ? `${redacted.slice(0, MAX_REASON)}…` : redacted;
}

/**
 * The response for a method no reachable backend implements. `failures` lists
 * the backends that threw while starting, as `{ id, error }`.
 */
export function unresolvedBackendResponse(method, failures = []) {
  if (failures.length === 0) {
    return {
      status: 501,
      body: { error: { message: `No attached backend implements ${method}`, code: 'backend_unsupported' } },
    };
  }
  const named = failures.slice(0, 3).map(({ id, error }) => `${id}: ${reasonOf(error)}`).join('; ');
  return {
    status: 503,
    body: {
      error: {
        message: `No backend that could serve ${method} is answering — ${named}`,
        code: 'backend_unavailable',
      },
    },
  };
}
