import { Platform } from 'react-native';

import { METHOD_GUIDANCE, METHOD_TO_ROUTE, resolveRoute } from '@/lib/gateway/rpc-routes';

import type {
  ChatCompletionResponse,
  ChatMessage,
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
};

const MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 30000;
const LONG_TIMEOUT_MS = 120000;

function randomId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

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
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private status: ConnectionStatus = 'disconnected';
  private detail = '';
  private currentSessionId: string | undefined;
  private readonly pendingRuns = new Map<string, PendingRun>();

  constructor(
    private profile: GatewayProfile,
    private callbacks: GatewayClientCallbacks = {},
  ) {}

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
  }

  /**
   * Connect: verify the gateway is reachable via /health.
   * If healthy, set status to connected and start background health monitoring.
   */
  async connect() {
    this.closed = false;
    this.clearReconnectTimer();
    this.setStatus('connecting');

    try {
      const health = await this.healthCheck();
      if (health) {
        this.reconnectAttempts = 0;
        this.setStatus('connected');
        this.callbacks.onHello?.({
          type: 'hello-ok',
          protocol: 1,
          server: { version: health.version },
        });
        this.callbacks.onHealthCheck?.(true, health);
        this.startHealthMonitoring();
      } else {
        this.callbacks.onError?.('Gateway health check failed');
        this.scheduleReconnect('Gateway did not respond');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.callbacks.onError?.(message);
      this.scheduleReconnect(message);
    }
  }

  disconnect() {
    this.closed = true;
    this.clearReconnectTimer();
    this.stopHealthMonitoring();
    this.abortAllRuns();
    // Restore session id onto profile before clearing
    if (this.currentSessionId) {
      this.profile.sessionId = this.currentSessionId;
    }
    this.setStatus('disconnected');
  }

  // ─── HTTP helpers ─────────────────────────────────────────────

  private get headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.profile.token) {
      h['Authorization'] = `Bearer ${this.profile.token}`;
    }
    if (this.profile.sessionKey) {
      h['X-Hermes-Session-Key'] = this.profile.sessionKey;
    }
    return h;
  }

  private get baseUrl(): string {
    return this.profile.url.replace(/\/+$/, '');
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const url = `${this.baseUrl}${path}`;
      const response = await fetch(url, {
        method,
        headers: this.headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        let errorMsg: string;
        try {
          const errorJson = JSON.parse(errorText);
          errorMsg = errorJson?.error?.message || errorJson?.error || errorText || `HTTP ${response.status}`;
        } catch {
          errorMsg = errorText || `HTTP ${response.status}`;
        }
        throw new Error(errorMsg);
      }

      const text = await response.text();
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`Request timed out: ${method} ${path}`);
      }
      throw error;
    }
  }

  /**
   * Stream SSE events from a response. Calls onChunk for each SSE data line.
   */
  private async streamSSE(
    response: Response,
    onChunk: (data: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body to stream');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') return;
          onChunk(data);
        }
      }
    }
  }

  // ─── API endpoints ────────────────────────────────────────────

  async healthCheck(timeoutMs = 5000): Promise<HealthResponse | null> {
    try {
      const result = await this.request<HealthResponse>('GET', '/health', undefined, timeoutMs);
      return result;
    } catch {
      return null;
    }
  }

  async getCapabilities(): Promise<GatewayCapabilities> {
    return this.request<GatewayCapabilities>('GET', '/v1/capabilities');
  }

  async getModels(): Promise<ModelInfo[]> {
    const result = await this.request<{ data: ModelInfo[] }>('GET', '/v1/models');
    return result.data;
  }

  async getSessions(limit = 20): Promise<HermesSession[]> {
    const result = await this.request<SessionsResponse>('GET', `/api/sessions?limit=${limit}`);
    return result.data;
  }

  async createSession(title?: string): Promise<HermesSession> {
    const body: Record<string, unknown> = {};
    if (title) body.title = title;
    const result = await this.request<{ session: HermesSession }>('POST', '/api/sessions', body);
    this.currentSessionId = result.session.id;
    return result.session;
  }

  async getSession(sessionId: string): Promise<HermesSession> {
    const result = await this.request<{ session: HermesSession }>('GET', `/api/sessions/${sessionId}`);
    return result.session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request<void>('DELETE', `/api/sessions/${sessionId}`);
  }

  async getSessionMessages(sessionId: string, limit = 50): Promise<SessionMessage[]> {
    const result = await this.request<SessionMessagesResponse>(
      'GET',
      `/api/sessions/${sessionId}/messages?limit=${limit}`,
    );
    return result.data;
  }

  /**
   * Send a chat message (non-streaming) via OpenAI-compatible endpoint.
   */
  async chatCompletion(
    messages: Array<{ role: string; content: string }>,
    options?: { model?: string; maxTokens?: number; sessionId?: string },
  ): Promise<ChatCompletionResponse> {
    const body: Record<string, unknown> = {
      model: options?.model ?? 'hermes-agent',
      messages,
      stream: false,
    };
    if (options?.maxTokens) body.max_tokens = options.maxTokens;

    const headers: Record<string, string> = { ...this.headers };
    if (options?.sessionId || this.currentSessionId) {
      headers['X-Hermes-Session-Id'] = options?.sessionId ?? this.currentSessionId!;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LONG_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(errorText || `HTTP ${response.status}`);
      }

      return await response.json() as ChatCompletionResponse;
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
  }

  /**
   * Stream a chat completion via SSE. Calls onDelta for each text chunk.
   */
  async streamChat(
    messages: Array<{ role: string; content: string }>,
    onDelta: (text: string) => void,
    options?: { model?: string; sessionId?: string; signal?: AbortSignal },
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model: options?.model ?? 'hermes-agent',
      messages,
      stream: true,
    };

    const headers: Record<string, string> = { ...this.headers };
    if (options?.sessionId || this.currentSessionId) {
      headers['X-Hermes-Session-Id'] = options?.sessionId ?? this.currentSessionId!;
    }

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(errorText || `HTTP ${response.status}`);
    }

    let fullText = '';
    await this.streamSSE(response, (data) => {
      try {
        const chunk = JSON.parse(data);
        const delta = chunk?.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          onDelta(delta);
        }
      } catch {
        // ignore malformed chunks
      }
    }, options?.signal);

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
    return this.request<RunResponse>('POST', '/v1/runs', body);
  }

  /**
   * Get run status.
   */
  async getRunStatus(runId: string): Promise<RunStatus> {
    return this.request<RunStatus>('GET', `/v1/runs/${runId}`);
  }

  /**
   * Stream run events via SSE. Calls onEvent for each event.
   */
  async streamRunEvents(
    runId: string,
    onEvent: (event: RunEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await fetch(`${this.baseUrl}/v1/runs/${runId}/events`, {
      headers: this.headers,
      signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    await this.streamSSE(response, (data) => {
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
    await this.request<void>('POST', `/v1/runs/${runId}/stop`, {});
  }

  /**
   * Resolve a pending run approval.
   */
  async resolveApproval(runId: string, approved: boolean, feedback?: string): Promise<void> {
    await this.request<void>('POST', `/v1/runs/${runId}/approval`, {
      approved,
      feedback,
    });
  }

  /**
   * Get skills list.
   */
  async getSkills(): Promise<unknown[]> {
    try {
      const result = await this.request<{ data?: unknown[] } | unknown[]>('GET', '/v1/skills');
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
      const result = await this.request<{ data?: unknown[] } | unknown[]>('GET', '/v1/toolsets');
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
    return this.request<T>(route.method, path, route.method === 'GET' ? undefined : body);
  }

  // ─── Health monitoring ────────────────────────────────────────

  private startHealthMonitoring() {
    this.stopHealthMonitoring();
    this.healthTimer = setInterval(async () => {
      if (this.closed) return;
      const health = await this.healthCheck();
      if (!health && this.status === 'connected') {
        this.setStatus('reconnecting', 'Gateway became unreachable');
        this.scheduleReconnect('Gateway became unreachable');
      } else if (health && this.status === 'reconnecting') {
        this.setStatus('connected');
        this.reconnectAttempts = 0;
      }
    }, 30000);
  }

  private stopHealthMonitoring() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  // ─── Reconnection ─────────────────────────────────────────────

  private scheduleReconnect(reason: string) {
    if (this.closed) return;
    if (this.reconnectAttempts >= 5) {
      this.setStatus('disconnected', reason);
      return;
    }
    this.reconnectAttempts += 1;
    const delay = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 15000);
    this.setStatus('reconnecting', `${reason} · retry in ${Math.round(delay / 1000)}s`);
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      if (!this.closed) void this.connect();
    }, delay);
  }

  // ─── Run management ───────────────────────────────────────────

  private abortAllRuns() {
    for (const [, run] of this.pendingRuns) {
      run.abortController?.abort();
    }
    this.pendingRuns.clear();
  }

  // ─── Utils ────────────────────────────────────────────────────

  private clearReconnectTimer() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private setStatus(status: ConnectionStatus, detail = '') {
    this.status = status;
    this.detail = detail;
    this.callbacks.onStatus?.(status, detail);
  }
}