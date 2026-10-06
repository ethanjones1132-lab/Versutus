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

// ─── Which backend answers a request that names none ───────────────────────
// It used to be simply the first registered environment. On a Mac that was
// Hermes, whose server could not start, so every request without a backendId
// failed while OpenCode sat there ready. Now: a configured default if it is
// usable, else the first environment whose state is ready, else a clear error
// naming every candidate's state. An environment nobody has probed yet (the
// state map starts empty after a Gate restart, or reads `stopped`) is probed
// once here, so the first request after a restart is not refused just because
// no client opened the Environments screen first.

const USABLE_STATES = new Set(['ready', 'busy']);
const UNPROBED_STATES = new Set([undefined, null, 'stopped']);

/**
 * @param {object} options
 * @param {Array<{id: string}>} options.entries backend-capable environments, in registration order
 * @param {(id: string) => string|undefined} options.stateOf current coarse state, if known
 * @param {(id: string) => Promise<string|undefined>} [options.probe] probes an unprobed environment, returns its state
 * @param {string} [options.defaultId] configured default backend id
 * @returns {Promise<{id: string} | {status: number, body: object}>}
 */
export async function selectDefaultBackend({ entries = [], stateOf, probe, defaultId } = {}) {
  if (entries.length === 0) {
    return {
      status: 404,
      body: { error: { message: 'No chat backend is attached to this Gate', code: 'no_backend' } },
    };
  }
  const states = new Map();
  const stateFor = async (id) => {
    if (states.has(id)) return states.get(id);
    let state = stateOf?.(id);
    if (UNPROBED_STATES.has(state) && probe) {
      try {
        state = (await probe(id)) ?? state;
      } catch (error) {
        state = `probe failed (${reasonOf(error)})`;
      }
    }
    states.set(id, state ?? 'unknown');
    return states.get(id);
  };

  const configured = defaultId ? entries.find((entry) => entry.id === defaultId) : undefined;
  if (configured && USABLE_STATES.has(await stateFor(configured.id))) return { id: configured.id };

  for (const entry of entries) {
    if (USABLE_STATES.has(await stateFor(entry.id))) return { id: entry.id };
  }

  const summary = entries
    .slice(0, 6)
    .map((entry) => `${entry.id}: ${states.get(entry.id) ?? 'unknown'}`)
    .join(', ');
  const unknownDefault = defaultId && !configured ? ` (configured default "${defaultId}" is not attached)` : '';
  return {
    status: 503,
    body: {
      error: {
        message: `No attached backend is ready${unknownDefault} — ${summary}. Pass backendId to choose one.`,
        code: 'no_ready_backend',
      },
    },
  };
}
