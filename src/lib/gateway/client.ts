import { createChatStreamAcc, interpretChatStreamChunk } from '@/lib/gateway/chat-stream-delta';
import { GatewayHttpError, isAuthRejection } from '@/lib/gateway/errors';
import { errorCodeFromHttpBody, messageFromHttpErrorBody } from '@/lib/gateway/http-error-body';
import { HttpTransport } from '@/lib/gateway/http-transport';
import {
  ConnectionMonitor,
  hasRecentContact,
} from '@/lib/gateway/connection-monitor';
import { flattenHermesModelOptions, type HermesModelOptions } from '@/lib/gateway/model-selection';
import { METHOD_GUIDANCE, METHOD_TO_ROUTE, resolveRoute } from '@/lib/gateway/rpc-routes';

import { streamingFetch } from '@/lib/net/streaming-fetch';
import type {
  ChatCompletionResponse,
  ConnectionStatus,
  GatewayCapabilities,
  GatewayProfile,
  HealthResponse,
  HermesSession,
  ModelInfo,
  RunEvent,
  RunResponse,
  RunStatus,
  SessionMessage,
  SessionMessagesResponse,
  SessionsResponse,
} from '@/lib/gateway/types';

export type GatewayClientCallbacks = {
  onStatus?: (status: ConnectionStatus, detail?: string) => void;
  onHello?: (hello: { type: 'hello-ok'; protocol: number; server: { version?: string } }) => void;
  onPairingRequired?: (details: unknown) => void;
  onChatEvent?: (payload: { deltaText?: string; state?: string; text?: string }) => void;
  onError?: (message: string) => void;
  onHealthCheck?: (healthy: boolean, info?: HealthResponse) => void;
  onCapabilities?: (capabilities: GatewayCapabilities) => void;
};

const LONG_TIMEOUT_MS = 120000;

type PendingRun = {
  runId: string;
  abortController: AbortController | null;
  onDelta?: (text: string) => void;
  onEvent?: (event: RunEvent) => void;
  onComplete?: (result: string) => void;
  onError?: (error: string) => void;
};

/**
 * Hermes Gateway HTTP Client.
 *
 * Connects to a Hermes API server (OpenAI-compatible REST + SSE) over HTTP.
 * Uses Bearer token auth (API_SERVER_KEY). No WebSocket or device pairing needed.
 */
export class HermesGatewayClient {
  private closed = false;
  private lastHealthError: string | null = null;
  private status: ConnectionStatus = 'disconnected';
  private detail = '';
  private currentSessionId: string | undefined;
  private readonly pendingRuns = new Map<string, PendingRun>();
  private transport: HttpTransport;
  private monitor: ConnectionMonitor;
  private connectAttempt: Promise<void> | null = null;

  constructor(
    private profile: GatewayProfile,
    private callbacks: GatewayClientCallbacks = {},
  ) {
    this.transport = new HttpTransport({
      baseUrl: profile.url,
      token: profile.token,
      sessionKey: profile.sessionKey,
    });
    this.monitor = new ConnectionMonitor({
      probe: async () => (await this.healthCheck()) !== null,
      recentlyServedUs: () => hasRecentContact(this.transport.lastContactAt, Date.now()),
      onStatus: (status, detail) => this.setStatus(status, detail),
      reconnect: () => this.connect().catch(() => undefined),
    });
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  get statusDetail(): string {
    return this.detail;
  }

  get sessionId(): string | undefined {
    return this.currentSessionId;
  }

  setSessionId(id: string | undefined) {
    this.currentSessionId = id;
  }

  updateProfile(profile: GatewayProfile) {
    this.profile = profile;
    this.transport.update({
      baseUrl: profile.url,
      token: profile.token,
      sessionKey: profile.sessionKey,
    });
  }

  /**
   * Connect: check reachability via /health, then prove the bearer key with an
   * authenticated call. Throws on auth rejection so the caller can stop and ask
   * for a new key; other failures fall through to backoff reconnect.
   *
   * Concurrent callers join the attempt already in flight rather than stack a
   * duplicate one: resumeReconnect() and the monitor's reconnect hook can both
   * fire while an earlier connect() is still awaiting health or capabilities,
   * and each duplicate re-fetched everything and raced its sibling through the
   * status machine. The handle clears once settled, so a connect() after a
   * real failure starts fresh.
   */
  async connect(): Promise<void> {
    if (this.connectAttempt) return this.connectAttempt;
    const attempt = this.attemptConnect().finally(() => {
      this.connectAttempt = null;
    });
    this.connectAttempt = attempt;
    return attempt;
  }

  private async attemptConnect(): Promise<void> {
    this.closed = false;
    this.setStatus('connecting');

    let health: HealthResponse | null;
    try {
      health = await this.healthCheck();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.callbacks.onError?.(message);
      this.monitor.scheduleReconnect(message);
      return;
    }

    if (!health) {
      const reason = this.lastHealthError ?? 'no response';
      this.callbacks.onError?.(`Could not reach ${this.transport.displayHost}: ${reason}`);
      this.monitor.scheduleReconnect(`No answer from ${this.transport.displayHost}`);
      return;
    }

    let capabilities: GatewayCapabilities | null = null;
    try {
      capabilities = await this.getCapabilities();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isAuthRejection(error)) {
        this.monitor.suspend();
        this.setStatus('disconnected', message);
        throw new Error(
          'Gateway rejected the API key. Enter API_SERVER_KEY from %LOCALAPPDATA%\\hermes\\.env.',
        );
      }
      // Capability catalog is optional; a gateway without it is still usable.
      this.callbacks.onError?.(message);
    }

    this.setStatus('connected');
    this.callbacks.onHello?.({
      type: 'hello-ok',
      protocol: 1,
      server: { version: health.version },
    });
    if (capabilities) this.callbacks.onCapabilities?.(capabilities);
    this.callbacks.onHealthCheck?.(true, health);
    this.monitor.noteConnected();
    this.monitor.start();
  }

  disconnect() {
    this.closed = true;
    this.monitor.stop();
    this.abortAllRuns();
    this.monitor.resume();
    // Restore session id onto profile before clearing
    if (this.currentSessionId) {
      this.profile.sessionId = this.currentSessionId;
    }
    this.setStatus('disconnected');
  }

  /**
   * Pause automatic reconnect (e.g. app backgrounded). The connection itself
   * is left alone; recovery happens on resumeReconnect()/foreground.
   */
  suspendReconnect() {
    this.monitor.suspend();
  }

  /**
   * Resume automatic reconnect and, if not connected, attempt immediately.
   */
  resumeReconnect() {
    this.monitor.resume();
    if (!this.closed && this.status !== 'connected') {
      void this.connect().catch(() => undefined);
    }
  }


  // ─── API endpoints ────────────────────────────────────────────

  /**
   * `timeoutMs` is generous on purpose: a phone radio waking from idle can take
   * seconds to complete its first request, and a false negative here reads as
   * "gateway down" to the whole app.
   */
  async healthCheck(timeoutMs = 12_000): Promise<HealthResponse | null> {
    try {
      const result = await this.transport.request<HealthResponse>('GET', '/health', undefined, timeoutMs);
      this.lastHealthError = null;
      return result;
    } catch (error) {
      // Keep the reason. Reporting a bare "did not respond" leaves the user
      // with no way to tell a DNS failure from a wrong port or a dead gateway.
      this.lastHealthError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  async getCapabilities(): Promise<GatewayCapabilities> {
    return this.transport.request<GatewayCapabilities>('GET', '/v1/capabilities');
  }

  async getModels(): Promise<ModelInfo[]> {
    // `/v1/models` is a single hermes-agent entry. The picker catalog is
    // GET /api/model/options (providers + their models). Older Hermes 404s
    // that path — fall through rather than emptying the picker.
    try {
      const options = await this.transport.request<HermesModelOptions>('GET', '/api/model/options');
      const flattened = flattenHermesModelOptions(options);
      if (flattened.length > 0) {
        return flattened.map((model) => ({
          id: model.id,
          object: 'model',
          owned_by: model.providerId,
          provider: model.provider,
          providerId: model.providerId,
          modelId: model.modelId,
          available: model.available,
        }));
      }
    } catch {
      // fall through
    }
    const result = await this.transport.request<{ data: ModelInfo[] }>('GET', '/v1/models');
    return result.data ?? [];
  }

  async getSessions(limit = 20): Promise<HermesSession[]> {
    // `/api/sessions` is a Hermes-NATIVE path. A Gate exposes `/v1/sessions` and
    // answers 404 to the `/api/*` form, so every session read through a Gate
    // failed and the sheet reported "Sessions could not be read" -- the delay
    // being the 404 and its retry, not a slow read (/v1/sessions answers in
    // ~80ms). Try the Gate path first, keep the Hermes one for a direct
    // connection. Same shape either way: { object, data }.
    try {
      const gate = await this.transport.request<SessionsResponse>('GET', `/v1/sessions?limit=${limit}`);
      if (Array.isArray(gate?.data)) return gate.data;
    } catch {
      // not a Gate, or it does not serve sessions -- fall through
    }
    const result = await this.transport.request<SessionsResponse>('GET', `/api/sessions?limit=${limit}`);
    return result.data ?? [];
  }

  /**
   * Opens a session, pinned to `model` when one is given.
   *
   * Native Hermes takes `model` as a string on POST /api/sessions. The Gate
   * serves only `/v1/*`: it takes `{ model: { modelId } }` on
   * POST /v1/sessions and answers the session directly instead of wrapped
   * as `{ session }`. A session opened without one is stuck on the host
   * default — Hermes refuses PATCH of `model`.
   */
  async createSession(title?: string, model?: string): Promise<HermesSession> {
    // The Hermes API server rejects an empty JSON body with 400
    // ("Invalid JSON in request body"). Send an explicit empty-string title
    // instead so the request shape is always valid.
    try {
      const gate = await this.transport.request<HermesSession | { session: HermesSession }>(
        'POST',
        '/v1/sessions',
        {
          title: title ?? '',
          // `{ modelId }` is the shape the Gate hands to backend.createSession.
          ...(model ? { model: { modelId: model } } : {}),
        },
      );
      const session = (gate as { session?: HermesSession })?.session ?? (gate as HermesSession);
      if (session && typeof session.id === 'string') {
        this.currentSessionId = session.id;
        return session;
      }
      // A 200 without a session id is not a session — fall through to the
      // native path rather than pin an unknown thread.
    } catch (error) {
      // A direct Hermes host answers the `/v1/*` path 404. Anything else is
      // the Gate's own answer — including its `{ error: { code:
      // 'session_create_failed' } }` refusal — and must surface rather than
      // silently retry another dialect.
      if (!(error instanceof GatewayHttpError) || error.status !== 404) throw error;
    }
    const result = await this.transport.request<{ session: HermesSession }>('POST', '/api/sessions', {
      title: title ?? '',
      ...(model ? { model } : {}),
    });
    this.currentSessionId = result.session.id;
    return result.session;
  }

  async getSession(sessionId: string): Promise<HermesSession> {
    const result = await this.transport.request<{ session: HermesSession }>('GET', `/api/sessions/${sessionId}`);
    return result.session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    // A Gate serves /v1/sessions for GET and POST only -- there is no remote
    // delete. Try the Hermes-native path and let its failure surface, rather
    // than reporting a deletion that never happened.
    await this.transport.request<void>('DELETE', `/api/sessions/${sessionId}`);
  }

  async getSessionMessages(sessionId: string, limit = 50): Promise<SessionMessage[]> {
    // The Gate serves only `/v1/*`: GET /v1/sessions/{id}/messages answers
    // `{ object: "list", data, hasMore, nextBefore }`. A direct Hermes host
    // answers the native GET /api/sessions/{id}/messages with `{ data }`.
    // Try the Gate dialect first and keep the native one for a genuine Hermes
    // host. Messages pass through in wire order with content untouched.
    try {
      const gate = await this.transport.request<SessionMessagesResponse>(
        'GET',
        `/v1/sessions/${sessionId}/messages?limit=${limit}`,
      );
      if (Array.isArray(gate?.data)) return gate.data;
    } catch (error) {
      // A direct Hermes host answers the `/v1/*` path 404. Anything else is
      // the Gate's own answer and must surface rather than silently retrying
      // another dialect.
      if (!(error instanceof GatewayHttpError) || error.status !== 404) throw error;
    }
    const result = await this.transport.request<SessionMessagesResponse>(
      'GET',
      `/api/sessions/${sessionId}/messages?limit=${limit}`,
    );
    return result.data;
  }

  /**
   * Send a chat message (non-streaming) via OpenAI-compatible endpoint.
   */
  async chatCompletion(
    messages: { role: string; content: string }[],
    options?: { model?: string; maxTokens?: number; sessionId?: string },
  ): Promise<ChatCompletionResponse> {
    const body: Record<string, unknown> = {
      model: options?.model ?? 'hermes-agent',
      messages,
      stream: false,
    };
    if (options?.maxTokens) body.max_tokens = options.maxTokens;

    const extraHeaders: Record<string, string> = {};
    if (options?.sessionId || this.currentSessionId) {
      extraHeaders['X-Hermes-Session-Id'] = options?.sessionId ?? this.currentSessionId!;
    }

    return this.transport.request<ChatCompletionResponse>(
      'POST',
      '/v1/chat/completions',
      body,
      LONG_TIMEOUT_MS,
      extraHeaders,
    );
  }

  /**
   * Stream a chat completion via SSE. Calls onDelta for each text chunk.
   */
  async streamChat(
    messages: { role: string; content: string }[],
    onDelta: (text: string) => void,
    options?: {
      model?: string;
      sessionId?: string;
      signal?: AbortSignal;
      onToolCall?: (tool: import('@/lib/gateway/types').ChatToolCall) => void;
      onReasoning?: (text: string) => void;
      onModelReport?: (report: import('@/lib/gateway/run-failures').ModelReport) => void;
    },
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model: options?.model ?? 'hermes-agent',
      messages,
      stream: true,
    };

    const extraHeaders: Record<string, string> = {};
    if (options?.sessionId || this.currentSessionId) {
      extraHeaders['X-Hermes-Session-Id'] = options?.sessionId ?? this.currentSessionId!;
    }

    const controller = new AbortController();
    const signal = options?.signal || controller.signal;

    const response = await streamingFetch(`${this.transport.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...this.transport.headers, ...extraHeaders },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      // The body is a JSON envelope. Throwing it verbatim is what put
      // `{"error":{"message":"hermes: 500 …","code":"backend_error"}}` inside an
      // assistant bubble on 2026-08-26 — wire text presented as if the model had
      // said it. The run-events path below already unwraps; this one must too,
      // so the banner and the bubble both read the human cause.
      const errorText = await response.text().catch(() => '');
      throw new Error(messageFromHttpErrorBody(errorText, response.status));
    }

    let fullText = '';
    // A failed turn can arrive as an error frame inside an HTTP 200 stream,
    // which response.ok above cannot catch. Captured rather than thrown,
    // because the handler's own catch would swallow a throw.
    let streamError: string | null = null;
    const acc = createChatStreamAcc();
    let lastModelReport: import('@/lib/gateway/run-failures').ModelReport | null = null;
    await this.transport.streamSSE(response, (data) => {
      try {
        const interpreted = interpretChatStreamChunk(JSON.parse(data), acc);
        if (interpreted.streamError) {
          streamError = interpreted.streamError;
          return;
        }
        if (interpreted.text) {
          fullText += interpreted.text;
          onDelta(interpreted.text);
        }
        if (interpreted.reasoning) {
          options?.onReasoning?.(interpreted.reasoning);
        }
        if (options?.onToolCall) {
          for (const tool of interpreted.toolCalls) options.onToolCall(tool);
        }
        if (options?.onModelReport && (interpreted.ranModel || interpreted.requestedModel || interpreted.provider)) {
          const report: import('@/lib/gateway/run-failures').ModelReport = {
            requested: interpreted.requestedModel,
            ran: interpreted.ranModel,
            provider: interpreted.provider,
          };
          const isDuplicate =
            lastModelReport !== null &&
            lastModelReport.requested === report.requested &&
            lastModelReport.ran === report.ran &&
            lastModelReport.provider === report.provider;
          if (!isDuplicate) {
            lastModelReport = report;
            options.onModelReport(report);
          }
        }
      } catch {
        // ignore malformed chunks
      }
    }, signal);

    if (streamError) throw new Error(streamError);
    return fullText;
  }

  /**
   * Start an async run via /v1/runs. Returns the run_id.
   */
  async startRun(
    prompt: string,
    options?: { sessionId?: string; model?: string },
  ): Promise<RunResponse> {
    const body: Record<string, unknown> = {
      input: prompt,
      model: options?.model ?? 'hermes-agent',
    };
    if (options?.sessionId || this.currentSessionId) {
      body.session_id = options?.sessionId ?? this.currentSessionId;
    }
    return this.transport.request<RunResponse>('POST', '/v1/runs', body);
  }

  /**
   * Get run status.
   */
  async getRunStatus(runId: string): Promise<RunStatus> {
    return this.transport.request<RunStatus>('GET', `/v1/runs/${runId}`);
  }

  /**
   * Stream run events via SSE. Calls onEvent for each event.
   */
  async streamRunEvents(
    runId: string,
    onEvent: (event: RunEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await streamingFetch(`${this.transport.baseUrl}/v1/runs/${runId}/events`, {
      headers: this.transport.headers,
      signal,
    });

    if (!response.ok) {
      // The Gate answers a replay miss fail-honestly (404 run_events_unavailable
      // since d1acb9d). Carry the code forward so the run-failure classifiers
      // render a desktop-parity verdict; without one, keep the message every
      // other surface shows — never a bare status when the body said more.
      const errorText = await response.text().catch(() => '');
      const message = messageFromHttpErrorBody(errorText, response.status);
      const code = errorCodeFromHttpBody(errorText);
      throw new Error(code === 'run_events_unavailable' ? `run_events_unavailable: ${message}` : message);
    }

    await this.transport.streamSSE(response, (data) => {
      try {
        const event = JSON.parse(data) as RunEvent;
        onEvent(event);
      } catch {
        // ignore
      }
    }, signal);
  }

  /**
   * Stop a running agent.
   */
  async stopRun(runId: string): Promise<void> {
    await this.transport.request<void>('POST', `/v1/runs/${runId}/stop`, {});
  }

  /**
   * Resolve a pending run approval.
   */
  async resolveApproval(runId: string, approved: boolean, feedback?: string): Promise<void> {
    await this.transport.request<void>('POST', `/v1/runs/${runId}/approval`, {
      approved,
      feedback,
    });
  }

  /**
   * Get skills list.
   */
  async getSkills(): Promise<unknown[]> {
    try {
      const result = await this.transport.request<{ data?: unknown[] } | unknown[]>('GET', '/v1/skills');
      return Array.isArray(result) ? result : (result as { data?: unknown[] }).data ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Get toolsets.
   */
  async getToolsets(): Promise<unknown[]> {
    try {
      const result = await this.transport.request<{ data?: unknown[] } | unknown[]>('GET', '/v1/toolsets');
      return Array.isArray(result) ? result : (result as { data?: unknown[] }).data ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Legacy request method — maps RPC-style method names to Hermes API endpoints.
   * This allows existing slash commands to work without full rewrites.
   */
  async rpcRequest<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const resolved = resolveRoute(method, params);
    if (!resolved) {
      const supported = Object.keys(METHOD_TO_ROUTE).length;
      const guidance = METHOD_GUIDANCE[method];
      throw new Error(
        `${method} is not supported by this gateway. ` +
          `The Hermes API server exposes ${supported} RPC-compatible methods.` +
          (guidance ? ` ${guidance}` : ''),
      );
    }
    const { route, path, body } = resolved;
    return this.transport.request<T>(route.method, path, route.method === 'GET' ? undefined : body);
  }

  // ─── Run management ───────────────────────────────────────────

  private abortAllRuns() {
    for (const [, run] of this.pendingRuns) {
      run.abortController?.abort();
    }
    this.pendingRuns.clear();
  }

  // ─── Utils ────────────────────────────────────────────────────

  private setStatus(status: ConnectionStatus, detail = '') {
    this.status = status;
    this.detail = detail;
    this.callbacks.onStatus?.(status, detail);
  }
}