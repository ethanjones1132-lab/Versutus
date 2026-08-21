import { createChatStreamAcc, interpretChatStreamChunk } from '@/lib/gateway/chat-stream-delta';
import { isAuthRejection } from '@/lib/gateway/errors';
import { HttpTransport } from '@/lib/gateway/http-transport';
import {
  ConnectionMonitor,
  HEALTH_INTERVAL_MS,
} from '@/lib/gateway/connection-monitor';
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
      recentlyServedUs: () =>
        this.transport.lastContactAt > 0 &&
        Date.now() - this.transport.lastContactAt < HEALTH_INTERVAL_MS,
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
   */
  async connect() {
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
    const result = await this.transport.request<{ data: ModelInfo[] }>('GET', '/v1/models');
    return result.data;
  }

  async getSessions(limit = 20): Promise<HermesSession[]> {
    const result = await this.transport.request<SessionsResponse>('GET', `/api/sessions?limit=${limit}`);
    return result.data;
  }

  async createSession(title?: string): Promise<HermesSession> {
    const body: Record<string, unknown> = {};
    if (title) body.title = title;
    const result = await this.transport.request<{ session: HermesSession }>('POST', '/api/sessions', body);
    this.currentSessionId = result.session.id;
    return result.session;
  }

  async getSession(sessionId: string): Promise<HermesSession> {
    const result = await this.transport.request<{ session: HermesSession }>('GET', `/api/sessions/${sessionId}`);
    return result.session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.transport.request<void>('DELETE', `/api/sessions/${sessionId}`);
  }

  async getSessionMessages(sessionId: string, limit = 50): Promise<SessionMessage[]> {
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
      const errorText = await response.text().catch(() => '');
      throw new Error(errorText || `HTTP ${response.status}`);
    }

    let fullText = '';
    // A failed turn can arrive as an error frame inside an HTTP 200 stream,
    // which response.ok above cannot catch. Captured rather than thrown,
    // because the handler's own catch would swallow a throw.
    let streamError: string | null = null;
    const acc = createChatStreamAcc();
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
        if (options?.onToolCall) {
          for (const tool of interpreted.toolCalls) options.onToolCall(tool);
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
      throw new Error(`HTTP ${response.status}`);
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