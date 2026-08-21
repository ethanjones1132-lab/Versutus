/**
 * Hermes as a chat backend — SPIKE.
 *
 * Hermes runs as a long-lived HTTP service and already owns sessions, a model
 * catalog, toolsets, skills and a full agentic run API. This maps that surface
 * onto the same backend interface the CLI environments implement, so the Gate
 * can front Hermes the way it fronts opencode/codex/claude-code and the app
 * sees one dialect instead of two gateways.
 *
 * Two things make this cheaper than it looks:
 *   - Hermes session objects are already almost exactly the shape the app
 *     parses (the app's `HermesSession` type was modelled on them).
 *   - Sessions live under `/api/sessions`, while models/runs live under `/v1`.
 *     That split is not a typo; it is what `/v1/capabilities` advertises.
 *
 * Verified against Hermes 0.20.3.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { runCli } from '../adapters/shared.mjs';
import { createBotArgs, ensureDistinctListenKey, validateBotId } from '../hermes-bot-create.mjs';
import { getHermesBot, listHermesBots, toPublicBot } from '../hermes-profiles.mjs';

/** Hermes sessions are already gateway-shaped; fill only what may be absent. */
export function toGatewaySession(session) {
  return {
    id: session.id,
    source: session.source ?? 'hermes',
    user_id: session.user_id ?? null,
    model: session.model ?? null,
    title: session.title ?? null,
    // Hermes reports seconds as a float; the app expects milliseconds.
    started_at: toMillis(session.started_at),
    ended_at: session.ended_at == null ? null : toMillis(session.ended_at),
    end_reason: session.end_reason ?? null,
    message_count: session.message_count ?? 0,
    tool_call_count: session.tool_call_count ?? 0,
    input_tokens: session.input_tokens ?? 0,
    output_tokens: session.output_tokens ?? 0,
    cache_read_tokens: session.cache_read_tokens ?? 0,
    cache_write_tokens: session.cache_write_tokens ?? 0,
    reasoning_tokens: session.reasoning_tokens ?? 0,
    estimated_cost_usd: session.estimated_cost_usd ?? null,
    actual_cost_usd: session.actual_cost_usd ?? null,
    api_call_count: session.api_call_count ?? 0,
    parent_session_id: session.parent_session_id ?? null,
    last_active: toMillis(session.last_active ?? session.started_at),
    preview: session.preview ?? session.title ?? null,
    has_system_prompt: Boolean(session.has_system_prompt),
    has_model_config: Boolean(session.has_model_config),
  };
}

function toMillis(value) {
  if (typeof value !== 'number') return Date.now();
  // Hermes emits epoch seconds; anything already past this bound is millis.
  return value > 1e12 ? value : Math.round(value * 1000);
}

/** Hermes message content is a plain string; the app wants text parts. */
export function toGatewayMessage(message) {
  const content = typeof message.content === 'string' && message.content
    ? [{ type: 'text', text: message.content }]
    : [];
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((call) => ({
        name: call.function?.name ?? call.name ?? 'tool',
        status: 'complete',
        id: call.id ?? message.tool_call_id ?? undefined,
      }))
    : [];

  return {
    id: String(message.id),
    role: message.role ?? 'assistant',
    content,
    timestamp: toMillis(message.timestamp),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

/** Build a backend bound to a running Hermes API server. */
export function createHermesBackend({
  baseUrl,
  apiKey,
  fetchImpl = fetch,
  profilesHome,
  executablePath,
  runCliImpl = runCli,
} = {}) {
  const root = String(baseUrl).replace(/\/+$/, '');

  async function call(path, init = {}) {
    const headers = { ...(init.headers ?? {}) };
    if (init.body) headers['Content-Type'] = 'application/json';
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetchImpl(`${root}${path}`, { ...init, headers });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let message = text || `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text);
        message = parsed?.error?.message ?? parsed?.detail ?? parsed?.message ?? message;
      } catch {
        // keep the raw text
      }
      const error = new Error(`hermes: ${message}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  return {
    kind: 'hermes',

    async listSessions() {
      const body = await call('/api/sessions');
      return (body.data ?? []).map(toGatewaySession);
    },

    async createSession({ title, model } = {}) {
      const payload = {};
      if (title) payload.title = title;
      if (model?.modelId) payload.model = model.modelId;
      const body = await call('/api/sessions', { method: 'POST', body: JSON.stringify(payload) });
      // Create answers `{object, session}` rather than the session directly.
      return toGatewaySession(body.session ?? body);
    },

    async deleteSession(sessionId) {
      await call(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    },

    async listMessages(sessionId, limit) {
      const body = await call(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
      const mapped = (body.data ?? [])
        .map(toGatewayMessage)
        .filter((message) => message.content.length > 0 || message.tool_calls);
      return typeof limit === 'number' ? mapped.slice(-limit) : mapped;
    },

    async sendMessage(sessionId, { text, model } = {}) {
      const payload = { message: text };
      if (model?.modelId) payload.model = model.modelId;
      if (model?.providerId) payload.provider = model.providerId;
      const body = await call(`/api/sessions/${encodeURIComponent(sessionId)}/chat`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      const content = body.message?.content;
      return {
        text: typeof content === 'string' ? content : '',
        message: {
          id: body.message?.id ? String(body.message.id) : `hermes-${Date.now()}`,
          role: body.message?.role ?? 'assistant',
          content: typeof content === 'string' && content ? [{ type: 'text', text: content }] : [],
        },
        usage: body.usage,
      };
    },

    /**
     * `/v1/models` reports Hermes as a single `hermes-agent` entry -- true to
     * the OpenAI contract (Hermes *is* the model from a caller's view) but
     * useless for a picker. The real catalog is `/api/model/options`: the
     * providers Hermes can route to, each with its own model list.
     */
    async listModels() {
      const body = await call('/api/model/options');
      const providers = Array.isArray(body.providers)
        ? body.providers
        : Object.values(body.providers ?? {});

      const models = [];
      for (const provider of providers) {
        const providerId = provider.slug ?? provider.id ?? provider.name;
        if (!providerId) continue;
        for (const modelId of provider.models ?? []) {
          models.push({
            id: `${providerId}/${modelId}`,
            providerId,
            modelId,
            label: `${provider.name ?? providerId} · ${modelId}`,
            available: true,
          });
        }
      }
      return models;
    },

    /**
     * Toolsets. The adapter declares the `tools` capability, so the Gate
     * advertises `tools: true` — which was a claim with nothing behind it: a
     * ready Tools tile over a command that could not run. This is what backs
     * the advertisement.
     */
    async listToolsets() {
      return call('/v1/toolsets');
    },

    async listSkills() {
      return call('/v1/skills');
    },

    async healthDetailed() {
      return call('/health/detailed');
    },

    /**
     * Cron jobs. Hermes serves the full CRUD here and answers 200, but reports
     * `jobs_admin: false` on its own /v1/capabilities. The Gate advertises from
     * what it can observably proxy, not from that self-report.
     */
    async listJobs() {
      return call('/api/jobs');
    },

    async runJob(jobId) {
      return call(`/api/jobs/${encodeURIComponent(jobId)}/run`, { method: 'POST' });
    },

    async setJobPaused(jobId, paused) {
      const action = paused ? 'pause' : 'resume';
      return call(`/api/jobs/${encodeURIComponent(jobId)}/${action}`, { method: 'POST' });
    },

    /**
     * Hermes exposes stop only on runs, not on a session chat turn. Left
     * unimplemented rather than faked: a no-op `abort` would tell the Gate a
     * turn was cancelled when it is still burning tokens upstream.
     */
    async abort() {
      throw new Error('hermes: session turns cannot be aborted; use the runs API');
    },

    /**
     * Agentic runs. This is the capability the Gate has never had: its CLI
     * backends run a turn synchronously, while Hermes accepts a run, returns an
     * id immediately, and streams events until it reaches a terminal state.
     */
    async startRun(prompt, { sessionId, model } = {}) {
      const payload = { input: prompt };
      if (sessionId) payload.session_id = sessionId;
      if (model) payload.model = model;
      return call('/v1/runs', { method: 'POST', body: JSON.stringify(payload) });
    },

    async getRunStatus(runId) {
      return call(`/v1/runs/${encodeURIComponent(runId)}`);
    },

    async stopRun(runId) {
      await call(`/v1/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST', body: JSON.stringify({}) });
    },

    async steerRun(runId, text) {
      await call(`/v1/runs/${encodeURIComponent(runId)}/steer`, {
        method: 'POST',
        body: JSON.stringify({ input: text }),
      });
    },

    /** Raw SSE stream, relayed by the Gate rather than parsed here. */
    async runEvents(runId, { signal } = {}) {
      const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
      const response = await fetchImpl(`${root}/v1/runs/${encodeURIComponent(runId)}/events`, {
        headers,
        signal,
      });
      if (!response.ok) {
        const error = new Error(`hermes: run events HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return response;
    },

    async replyApproval(runId, { approved, feedback } = {}) {
      await call(`/v1/runs/${encodeURIComponent(runId)}/approval`, {
        method: 'POST',
        body: JSON.stringify({ approved, ...(feedback ? { feedback } : {}) }),
      });
    },

    /**
     * Streaming turns.
     *
     * The Gate's other backends are subscribe-then-send: `streamEvents` opens a
     * feed, `sendMessage` pushes the turn down it. Hermes has no such split --
     * one POST both sends and streams -- so this is modelled as what it is
     * rather than faked as a two-step handshake, and `streamEvents` stays a
     * no-op for the same reason `abort` throws: an empty subscription that
     * never yields is worse than an absent one.
     *
     * /v1/chat/completions is chosen over the session-native
     * /api/sessions/{id}/chat/stream because it emits OpenAI-shaped chunks --
     * exactly what the Gate already writes to its own clients -- so the turn
     * can be relayed instead of translated. The session binding comes from
     * X-Hermes-Session-Id, which is the same path the app's own Hermes client
     * takes, and the same session the non-streaming `sendMessage` writes to.
     *
     * Returns the raw Response: the caller owns the framing.
     */
    async sendMessageStreaming(sessionId, { text, model } = {}, signal) {
      const headers = {
        'Content-Type': 'application/json',
        'X-Hermes-Session-Id': sessionId,
      };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const response = await fetchImpl(`${root}/v1/chat/completions`, {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify({
          model: model?.modelId ?? 'hermes-agent',
          ...(model?.providerId ? { provider: model.providerId } : {}),
          messages: [{ role: 'user', content: text }],
          stream: true,
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        const error = new Error(`hermes: ${detail || `HTTP ${response.status}`}`);
        error.status = response.status;
        throw error;
      }
      return response;
    },

    async streamEvents() {},

    async listBots() {
      if (!profilesHome) return { object: 'list', data: [] };
      const records = await listHermesBots(profilesHome);
      return { object: 'list', data: records.map(toPublicBot) };
    },

    async forBot(botId) {
      if (!profilesHome) {
        const error = new Error('Hermes home is not configured');
        error.code = 'unknown_bot';
        error.status = 404;
        throw error;
      }
      const record = await getHermesBot(profilesHome, botId);
      if (!record) {
        const error = new Error(`unknown bot "${botId}"`);
        error.code = 'unknown_bot';
        error.status = 404;
        throw error;
      }
      if (!record.listenKey) {
        const error = new Error(`bot "${botId}" has no API_SERVER_KEY`);
        error.code = 'bot_not_routable';
        error.status = 409;
        throw error;
      }
      return createHermesBackend({
        baseUrl: `${root}/p/${encodeURIComponent(botId)}`,
        apiKey: record.listenKey,
        fetchImpl,
        profilesHome,
        executablePath,
        runCliImpl,
      });
    },

    async createBot({ name, soul, inheritKeys = false, description, modelId, providerId } = {}) {
      const id = validateBotId(name);
      if (!id) {
        const error = new Error('invalid bot name');
        error.code = 'invalid_bot_name';
        error.status = 400;
        throw error;
      }
      if (!profilesHome || !executablePath) {
        const error = new Error('Hermes executable or home is not configured');
        error.code = 'backend_unsupported';
        error.status = 501;
        throw error;
      }
      const existing = await getHermesBot(profilesHome, id);
      if (existing) {
        const error = new Error(`bot "${id}" already exists`);
        error.code = 'bot_exists';
        error.status = 409;
        throw error;
      }
      const args = createBotArgs({ name: id, inheritKeys, description });
      const result = await runCliImpl(executablePath, args, { timeoutMs: 60_000 });
      if (result.code !== 0) {
        const error = new Error(result.stderr || result.stdout || `hermes profile create exited ${result.code}`);
        error.code = 'bot_create_failed';
        error.status = 502;
        throw error;
      }
      const botHome = join(profilesHome, 'profiles', id);
      await mkdir(botHome, { recursive: true });
      const defaultKey = (await getHermesBot(profilesHome, 'default'))?.listenKey ?? null;
      let envText = '';
      try {
        envText = await readFile(join(botHome, '.env'), 'utf8');
      } catch {
        envText = '';
      }
      const ensured = ensureDistinctListenKey(envText, defaultKey);
      await writeFile(join(botHome, '.env'), ensured.envText, 'utf8');
      if (typeof soul === 'string' && soul.trim()) {
        await writeFile(join(botHome, 'SOUL.md'), soul, 'utf8');
      }
      if (modelId) {
        const pin = await runCliImpl(
          executablePath,
          ['-p', id, 'config', 'set', 'model.default', String(modelId)],
          { timeoutMs: 15_000 },
        );
        if (pin.code !== 0) {
          const error = new Error(pin.stderr || 'failed to pin model');
          error.code = 'bot_create_failed';
          error.status = 502;
          throw error;
        }
      }
      if (providerId) {
        await runCliImpl(
          executablePath,
          ['-p', id, 'config', 'set', 'model.provider', String(providerId)],
          { timeoutMs: 15_000 },
        );
      }
      const record = await getHermesBot(profilesHome, id);
      return toPublicBot(record ?? { id, displayName: id, listenKey: ensured.listenKey, home: botHome });
    },
  };
}
