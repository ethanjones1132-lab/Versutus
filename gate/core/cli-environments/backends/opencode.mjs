/**
 * OpenCode as a chat backend.
 *
 * OpenCode owns its own sessions, model catalog, tools and approvals; the Gate
 * proxies to them rather than reimplementing any of it. Shapes here are the ones
 * verified live against 1.18.18 — see docs/opencode-backend-contract.md.
 */

/** Translate an OpenCode session into the shape the app already parses. */
export function toGatewaySession(session) {
  const tokens = session.tokens ?? {};
  return {
    id: session.id,
    source: 'opencode',
    user_id: null,
    model: session.model?.modelID ?? null,
    title: session.title ?? null,
    started_at: session.time?.created ?? Date.now(),
    ended_at: null,
    end_reason: null,
    message_count: session.message_count ?? 0,
    tool_call_count: 0,
    input_tokens: tokens.input ?? 0,
    output_tokens: tokens.output ?? 0,
    cache_read_tokens: tokens.cache?.read ?? 0,
    cache_write_tokens: tokens.cache?.write ?? 0,
    reasoning_tokens: tokens.reasoning ?? 0,
    estimated_cost_usd: typeof session.cost === 'number' ? session.cost : null,
    actual_cost_usd: null,
    api_call_count: 0,
    parent_session_id: session.parentID ?? null,
    last_active: session.time?.updated ?? session.time?.created ?? Date.now(),
    preview: session.title ?? null,
    has_system_prompt: false,
    has_model_config: Boolean(session.model),
  };
}

/**
 * Flatten an OpenCode message. Text parts become the `{type,text}[]` content the
 * app's extractMessageText already understands; tool parts are surfaced rather
 * than dropped, since they are the whole point of a native environment.
 */
export function toGatewayMessage(message) {
  const info = message.info ?? {};
  const parts = message.parts ?? [];
  const content = parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => ({ type: 'text', text: part.text }));
  const toolCalls = parts
    .filter((part) => part.type === 'tool')
    .map((part) => ({ name: part.tool, status: mapToolStatus(part.state?.status), id: part.callID }));

  return {
    id: info.id,
    role: info.role ?? 'assistant',
    content,
    timestamp: info.time?.created,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function mapToolStatus(status) {
  if (status === 'completed') return 'complete';
  if (status === 'error' || status === 'failed') return 'error';
  return 'running';
}

const TERMINAL_TOOL_STATES = new Set(['completed', 'error', 'failed']);

/**
 * Map an OpenCode bus event onto the normalized vocabulary in
 * docs/cli-environment-interface-v1.md. Anything unrecognised becomes a
 * diagnostic — never silently dropped, so a new upstream event is visible
 * rather than invisible.
 */
export function normalizeOpenCodeEvent(event) {
  if (!event?.type) return null;
  const props = event.properties ?? {};
  const sessionId = props.sessionID;

  switch (event.type) {
    case 'message.part.delta': {
      if (props.field !== 'text' || typeof props.delta !== 'string') break;
      return frame('message.delta', { sessionId, text: props.delta, messageId: props.messageID, partId: props.partID });
    }
    case 'message.part.updated': {
      const part = props.part;
      if (part?.type !== 'tool') break;
      const status = part.state?.status;
      const type = TERMINAL_TOOL_STATES.has(status) ? 'tool.output' : 'tool.started';
      return frame(type, {
        sessionId,
        name: part.tool,
        callId: part.callID,
        status,
        output: part.state?.output ?? part.state?.raw,
      });
    }
    case 'message.updated': {
      const tokens = props.info?.tokens;
      if (!tokens) break;
      return frame('usage', { sessionId, tokens, cost: props.info?.cost });
    }
    case 'session.idle':
      return frame('run.completed', { sessionId });
    case 'session.error':
      return frame('run.failed', { sessionId, error: props.error });
    case 'permission.asked':
    case 'permission.v2.asked':
      return frame('approval.required', {
        sessionId,
        approvalId: props.id,
        action: props.action ?? props.permission,
        resources: props.resources ?? props.patterns,
      });
    default:
      break;
  }
  return frame('diagnostic', { sessionId, source: event.type, properties: props });
}

function frame(type, payload) {
  return { type, payload };
}

/** Build a backend bound to a running OpenCode server. */
export function createOpenCodeBackend({ baseUrl, fetchImpl = fetch, password } = {}) {
  const root = String(baseUrl).replace(/\/+$/, '');

  async function call(path, init = {}) {
    const headers = { ...(init.headers ?? {}) };
    if (init.body) headers['Content-Type'] = 'application/json';
    if (password) headers.Authorization = `Bearer ${password}`;
    const response = await fetchImpl(`${root}${path}`, { ...init, headers });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let message = text || `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text);
        message = parsed?.data?.message ?? parsed?.message ?? parsed?.name ?? message;
      } catch {
        // keep the raw text
      }
      throw new Error(`opencode: ${message}`);
    }
    return response.json();
  }

  return {
    kind: 'opencode',

    async listSessions() {
      const sessions = await call('/session');
      return (Array.isArray(sessions) ? sessions : []).map(toGatewaySession);
    },

    async createSession({ title, model } = {}) {
      const body = {};
      if (title) body.title = title;
      if (model?.providerId) body.model = { providerID: model.providerId, id: model.modelId };
      return toGatewaySession(await call('/session', { method: 'POST', body: JSON.stringify(body) }));
    },

    async deleteSession(sessionId) {
      await call(`/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    },

    async listMessages(sessionId, limit) {
      const messages = await call(`/session/${encodeURIComponent(sessionId)}/message`);
      const mapped = (Array.isArray(messages) ? messages : []).map(toGatewayMessage);
      return typeof limit === 'number' ? mapped.slice(-limit) : mapped;
    },

    /** Blocks until the turn completes; live deltas come from streamEvents. */
    async sendMessage(sessionId, { text, model } = {}) {
      const body = { parts: [{ type: 'text', text }] };
      if (model?.providerId) body.model = { providerID: model.providerId, modelID: model.modelId };
      const message = await call(`/session/${encodeURIComponent(sessionId)}/message`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      // OpenCode's own /message route answers 200 even when the *upstream*
      // model call failed (e.g. the provider 404s) — the failure is folded
      // into `info.error` with `parts` left empty, never a non-ok HTTP
      // response. Trusting that as success would be the same mistake Claude
      // Code's `result.subtype === 'success'` almost caused for auth failures.
      if (message?.info?.error) {
        const upstream = message.info.error;
        throw new Error(`opencode: ${upstream.data?.message ?? upstream.name ?? 'the turn failed upstream'}`);
      }
      const mapped = toGatewayMessage(message);
      return {
        message: mapped,
        text: mapped.content.map((part) => part.text).join(''),
      };
    },

    async abort(sessionId) {
      await call(`/session/${encodeURIComponent(sessionId)}/abort`, { method: 'POST' });
    },

    async replyApproval(sessionId, requestId, reply) {
      await call(
        `/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
        { method: 'POST', body: JSON.stringify({ reply }) },
      );
    },

    /** Every model the CLI can actually reach, qualified by its own provider. */
    async listModels() {
      const config = await call('/config/providers');
      const models = [];
      for (const provider of config.providers ?? []) {
        for (const modelId of Object.keys(provider.models ?? {})) {
          models.push({
            id: `${provider.id}/${modelId}`,
            providerId: provider.id,
            modelId,
            label: `${provider.name ?? provider.id} · ${modelId}`,
            available: true,
          });
        }
      }
      return models;
    },

    /** Read the shared bus, emitting normalized events for one session. */
    async streamEvents(sessionId, onEvent, signal) {
      const response = await fetchImpl(`${root}/event`, {
        signal,
        headers: password ? { Authorization: `Bearer ${password}` } : {},
      });
      const reader = response.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          if (signal?.aborted) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            let parsed;
            try {
              parsed = JSON.parse(line.slice(6));
            } catch {
              continue;
            }
            // The bus is global; a session's stream must not leak other sessions.
            if (sessionId && parsed.properties?.sessionID && parsed.properties.sessionID !== sessionId) continue;
            const normalized = normalizeOpenCodeEvent(parsed);
            if (normalized) onEvent(normalized);
            if (normalized?.type === 'run.completed' || normalized?.type === 'run.failed') return;
          }
        }
      } finally {
        reader.cancel().catch(() => undefined);
      }
    },
  };
}
