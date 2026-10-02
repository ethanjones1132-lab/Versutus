import { readChatFrames } from '@/lib/gateway/turns';
import { GatewayHttpError, isAuthRejection } from '@/lib/gateway/errors';
import { withGetSessionsRetry } from '@/lib/gateway/get-sessions-retry';
import { errorCodeFromHttpBody, messageFromHttpErrorBody } from '@/lib/gateway/http-error-body';
import { HttpTransport, assertChatStreamComplete } from '@/lib/gateway/http-transport';
import {
  ConnectionMonitor,
  hasRecentContact,
} from '@/lib/gateway/connection-monitor';
import { flattenHermesModelOptions, type HermesModelOptions } from '@/lib/gateway/model-selection';
import { createMessageId } from '@/lib/gateway/messages';
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
  SessionMessagePage,
  SessionMessagesResponse,
  SessionsResponse,
} from '@/lib/gateway/types';

export type GatewayClientCallbacks = {
  onStatus?: (
    status: ConnectionStatus,
    detail?: string,
    info?: { authRejected?: boolean },
  ) => void;
  onHello?: (hello: { type: 'hello-ok'; protocol: number; server: { version?: string } }) => void;
  onPairingRequired?: (details: unknown) => void;
  onChatEvent?: (payload: { deltaText?: string; state?: string; text?: string }) => void;
  onError?: (message: string) => void;
  onHealthCheck?: (healthy: boolean, info?: HealthResponse) => void;
  onCapabilities?: (capabilities: GatewayCapabilities) => void;
};

const LONG_TIMEOUT_MS = 120000;

/** A cancel is a courtesy call; it must never hold a sheet open. */
export const CANCEL_TURN_TIMEOUT_MS = 5_000;

/**
 * Turn id the Gate correlates a streamed chat with its server-side cancel.
 *
 * The protocol accepts 8–64 characters of `[A-Za-z0-9_-]`, which is exactly
 * createMessageId's alphabet; the strip is there so a future prefix change
 * cannot silently produce a header the Gate refuses.
 */
export function createTurnId(): string {
  return createMessageId('turn').replace(/[^A-Za-z0-9_-]/g, '');
}

/**
 * Resolve with `promise`, or reject the moment `signal` aborts.
 *
 * The transport owns its own timeout controller and exposes no external abort
 * seam, so a refresh on a client the provider has already left cannot cancel
 * the underlying request from here. This stops the CALLER waiting on it, which
 * lets the refresh stand down instead of walking the rest of its serial chain
 * out to each request's own timeout.
 */
export function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('The operation was aborted.'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('The operation was aborted.'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Connect and the connection-monitor probe share this budget.
 *
 * 3s was proposed so a stalled first /health fails fast. It is too short
 * here. This app reaches the gateway over Tailscale (see extra.gatewayHosts
 * in app.json) as well as LAN. Phone → PC over a DERP relay was measured at
 * 0.9–1.7s RTT with loss, and a 3–3.5s /health aborts while the TCP
 * handshake is still in SynReceived — the same measurement that set
 * GATEWAY_PROBE_TIMEOUT_MS in probe.ts to 12s. A false negative here is
 * "gateway down" to the whole app. 12s matches discovery so a host that
 * passed reachability can still connect.
 */
export const HEALTH_CHECK_TIMEOUT_MS = 12_000;

export {
  GET_SESSIONS_ATTEMPT_TIMEOUT_MS,
  GET_SESSIONS_LARGE_ATTEMPT_TIMEOUT_MS,
  GET_SESSIONS_MAX_RETRIES,
  GET_SESSIONS_RETRY_BACKOFF_MS,
} from '@/lib/gateway/get-sessions-retry';

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
  /**
   * Bumped by disconnect(). An attemptConnect that started under an older
   * epoch is talking to a gateway the provider has already discarded, so
   * every await it resumes from has to be able to tell.
   */
  private connectEpoch = 0;
  private authRejectedState = false;
  private lastHealthError: string | null = null;
  private status: ConnectionStatus = 'disconnected';
  private detail = '';
  private currentSessionId: string | undefined;
  private readonly pendingRuns = new Map<string, PendingRun>();
  private transport: HttpTransport;
  private monitor: ConnectionMonitor;
  private connectAttempt: Promise<void> | null = null;
  private modelDialect: 'hermes' | 'gate' | null = null;

  constructor(
    private profile: GatewayProfile,
    private callbacks: GatewayClientCallbacks = {},
  ) {
    this.transport = new HttpTransport({
      baseUrl: profile.url,
      token: profile.token,
      sessionKey: profile.sessionKey,
      alternateIpv4: profile.alternateIpv4,
      // A timed-out request, a refused connection or a stalled stream is
      // evidence of a dead path that the 30s interval cannot act on for half a
      // minute more. Hand it to the monitor instead: two quick probes reach
      // `reconnecting` in ~2s.
      onNetworkTrouble: (reason) => this.nudge(reason),
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

  /**
   * True while the last disconnect was the gateway refusing our credentials.
   * The provider's onStatus handler sees that status before the connect()
   * rejection reaches it, so without this signal it cannot tell "wrong key"
   * from "gateway down" and schedules a retry that can never succeed.
   */
  get authRejected(): boolean {
    return this.authRejectedState;
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
      alternateIpv4: profile.alternateIpv4,
      // update() REPLACES the whole option set, so the hook has to be restated
      // here or the first profile change silently drops trouble reporting.
      onNetworkTrouble: (reason) => this.nudge(reason),
    });
    // A new endpoint may speak the other dialect; re-identify on next read.
    this.modelDialect = null;
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
    const epoch = this.connectEpoch;
    this.closed = false;
    this.setStatus('connecting');

    let health: HealthResponse | null;
    try {
      health = await this.healthCheck();
    } catch (error) {
      if (this.connectEpoch !== epoch) return;
      const message = error instanceof Error ? error.message : String(error);
      this.callbacks.onError?.(message);
      this.monitor.scheduleReconnect(message);
      return;
    }
    if (this.connectEpoch !== epoch) return;

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
      if (this.connectEpoch !== epoch) return;
      const message = error instanceof Error ? error.message : String(error);
      if (isAuthRejection(error)) {
        this.monitor.suspend();
        this.authRejectedState = true;
        this.setStatus('disconnected', message, { authRejected: true });
        throw new Error(
          'Gateway rejected the API key. Enter API_SERVER_KEY from %LOCALAPPDATA%\\hermes\\.env.',
        );
      }
      // Capability catalog is optional; a gateway without it is still usable.
      this.callbacks.onError?.(message);
    }
    if (this.connectEpoch !== epoch) return;

    this.authRejectedState = false;
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
    this.connectEpoch += 1;
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

  /**
   * Ask the monitor for a health verdict now, on the caller's own evidence of
   * trouble. Two quick failures reach `reconnecting` in ~2s instead of waiting
   * out two 30s samples.
   */
  nudge(reason: string) {
    this.monitor.nudge(reason);
  }

  /**
   * Re-verify in place. For a caller that doubts a client which still claims
   * 'connected': rebuilding the client throws away a live connection to
   * re-earn the answer, and this runs the same connect() attempt on the
   * existing one.
   */
  forceReconnect() {
    this.setStatus('reconnecting', 'Checking the connection');
    void this.connect().catch(() => undefined);
  }


  // ─── API endpoints ────────────────────────────────────────────

  /**
   * `timeoutMs` defaults to HEALTH_CHECK_TIMEOUT_MS (12s). See that constant
   * for why this is not a 3s fail-fast: a Tailscale cold path can legitimately
   * take seconds, and aborting it reads as "gateway down".
   */
  async healthCheck(timeoutMs = HEALTH_CHECK_TIMEOUT_MS): Promise<HealthResponse | null> {
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
    // that path — fall through rather than emptying the picker. A Gate is
    // the reverse: it serves only `/v1/*` and 404s the native path, so an
    // unremembered client pays two requests for every cold model read.
    // Remember the dialect that answered, per connection, and lead with it
    // next time. Direct Hermes keeps leading with its full provider catalog
    // rather than the single compatibility model from `/v1/models`.
    if (this.modelDialect === 'gate') {
      try {
        const remembered = await this.readGateModels();
        return remembered;
      } catch (error) {
        // A direct Hermes host answers the `/v1/*` path 404. Anything else
        // is the Gate's own answer and must surface rather than silently
        // retrying another dialect.
        if (!(error instanceof GatewayHttpError) || error.status !== 404) throw error;
        const fallback = await this.readHermesModelOptions();
        if (fallback) {
          this.modelDialect = 'hermes';
          return fallback;
        }
        // Neither dialect answered: the Gate path already 404'd and the
        // native path is empty or missing too. Report the Gate refusal
        // rather than re-requesting a path that just failed.
        throw error;
      }
    }
    // Unknown or Hermes-remembered dialect: lead with the native path so a
    // direct Hermes host keeps its full provider catalog instead of the
    // single compatibility model from `/v1/models`. Only a missing native
    // route (404) identifies a Gate, so a transient failure never flips a
    // Hermes host onto the compatibility model.
    let nativeRouteMissing = false;
    try {
      const options = await this.transport.request<HermesModelOptions>('GET', '/api/model/options');
      const flattened = flattenHermesModelOptions(options);
      if (flattened.length > 0) {
        this.modelDialect = 'hermes';
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
    } catch (error) {
      nativeRouteMissing = error instanceof GatewayHttpError && error.status === 404;
      // Any other failure falls through to the Gate path below without
      // remembering it — the next read still leads with the full catalog.
    }
    const result = await this.transport.request<{ data: ModelInfo[] }>('GET', '/v1/models');
    if (nativeRouteMissing) this.modelDialect = 'gate';
    return result.data ?? [];
  }

  private async readHermesModelOptions(): Promise<ModelInfo[] | null> {
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
      return null;
    } catch {
      return null;
    }
  }

  private async readGateModels(): Promise<ModelInfo[]> {
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
      const gate = await this.getSessionsFromPath(`/v1/sessions?limit=${limit}`, limit);
      if (Array.isArray(gate?.data)) return gate.data;
    } catch (error) {
      // A direct Hermes host answers the `/v1/*` path 404. Anything else is
      // the Gate's own answer and must surface rather than silently retrying
      // another dialect. 404 is never retried — it is the dialect signal.
      if (!(error instanceof GatewayHttpError) || error.status !== 404) throw error;
    }
    const result = await this.transport.request<SessionsResponse>('GET', `/api/sessions?limit=${limit}`);
    return result.data ?? [];
  }

  /**
   * GET /v1/sessions with the shared bounded retry. 404 is not retried so
   * the /api/sessions fallback stays a single extra request; `limit` decides
   * the per-attempt budget, because a bulk read is a different read.
   */
  private async getSessionsFromPath(path: string, limit?: number): Promise<SessionsResponse> {
    return withGetSessionsRetry(
      (timeoutMs) => this.transport.request<SessionsResponse>('GET', path, undefined, timeoutMs),
      { limit },
    );
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
    // The Gate serves only `/v1/*`: DELETE /v1/sessions/{id} answers
    // `{ deleted: true }`. A direct Hermes host answers the native
    // DELETE /api/sessions/{id}. Try the Gate dialect first and keep the
    // native one for a genuine Hermes host. Anything other than a 404 on
    // the Gate path is the Gate's own answer and must surface rather than
    // silently retrying another dialect.
    try {
      await this.transport.request<void>('DELETE', `/v1/sessions/${sessionId}`);
      return;
    } catch (error) {
      // A direct Hermes host answers the `/v1/*` path 404. Anything else is
      // the Gate's own answer and must surface rather than silently retrying
      // another dialect.
      if (!(error instanceof GatewayHttpError) || error.status !== 404) throw error;
    }
    await this.transport.request<void>('DELETE', `/api/sessions/${sessionId}`);
  }

  async getSessionMessages(sessionId: string, limit = 50): Promise<SessionMessage[]> {
    return (await this.getSessionMessagePage(sessionId, limit)).messages;
  }

  /**
   * One page of history, oldest-first, ending just before `before`.
   *
   * The array-returning `getSessionMessages` cannot express "the page before
   * this one", which forced load-earlier to re-fetch the whole window with an
   * ever-larger limit. The Gate answers `{ object: "list", data, hasMore,
   * nextBefore }` and those cursors travel on the page; a direct Hermes host
   * answers the native path with `{ data }` and no cursors, so those stay
   * undefined and the caller keeps its short-page heuristic. Messages pass
   * through in wire order with content untouched.
   */
  async getSessionMessagePage(
    sessionId: string,
    limit = 50,
    before?: string,
  ): Promise<SessionMessagePage> {
    // The Gate serves only `/v1/*`. A direct Hermes host answers the native
    // GET /api/sessions/{id}/messages with `{ data }`. Try the Gate dialect
    // first and keep the native one for a genuine Hermes host.
    const query = `limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
    try {
      const gate = await this.transport.request<SessionMessagesResponse>(
        'GET',
        `/v1/sessions/${sessionId}/messages?${query}`,
      );
      if (Array.isArray(gate?.data)) {
        return { messages: gate.data, hasMore: gate.hasMore, nextBefore: gate.nextBefore };
      }
    } catch (error) {
      // A direct Hermes host answers the `/v1/*` path 404. Anything else is
      // the Gate's own answer and must surface rather than silently retrying
      // another dialect.
      if (!(error instanceof GatewayHttpError) || error.status !== 404) throw error;
    }
    const result = await this.transport.request<SessionMessagesResponse>(
      'GET',
      `/api/sessions/${sessionId}/messages?${query}`,
    );
    return { messages: result.data ?? [] };
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
    messages: { role: string; content: string | import('@/lib/gateway/chat-parts').ChatContentPart[] }[],
    onDelta: (text: string) => void,
    options?: {
      model?: string;
      sessionId?: string;
      signal?: AbortSignal;
      onToolCall?: (tool: import('@/lib/gateway/types').ChatToolCall) => void;
      onReasoning?: (text: string) => void;
      onTelemetryWarning?: (message: string) => void;
      onModelReport?: (report: import('@/lib/gateway/run-failures').ModelReport) => void;
      /** The turn id minted for this send, so a cancel can name it. */
      onTurnId?: (turnId: string) => void;
      /** The id to send under, when the caller minted this line's turn already. */
      turnId?: string;
      /** The gateway accepted the turn: its stream started. */
      onAccepted?: (turnId: string) => void;
      /** A session the gateway adopted for the turn, when it reports one. */
      onSession?: (sessionId: string) => void;
    },
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model: options?.model ?? 'hermes-agent',
      messages,
      stream: true,
    };

    const sessionId = options?.sessionId ?? this.currentSessionId;
    const extraHeaders: Record<string, string> = {};
    if (sessionId) {
      extraHeaders['X-Hermes-Session-Id'] = sessionId;
    }

    // A turn id is minted even though a stock Hermes ignores it, so callers get
    // one handle per send and a Gate that does read it can correlate the turn.
    // The header itself stays off this request: an unknown header on a direct
    // Hermes is a wire change we have no reason to make. A caller that already
    // owns a turn id — a queued line's resend — passes it in, so every send of
    // these words is the same turn rather than a fresh one.
    const turnId = options?.turnId ?? createTurnId();
    options?.onTurnId?.(turnId);

    const controller = new AbortController();
    // A caller-owned signal is wired INTO this controller rather than used
    // instead of it, so the one signal the request runs under is always one
    // `pendingRuns` holds — otherwise `disconnect()` could not stop a turn whose
    // signal belonged to the provider, which is every turn the app sends.
    const callerSignal = options?.signal;
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const signal = controller.signal;
    // Registered for the whole life of the turn, so a client that is discarded
    // mid-stream stops the stream instead of leaving it reading for a thread the
    // phone has left. The map was declared for exactly this and never filled.
    this.pendingRuns.set(turnId, { runId: turnId, abortController: controller });

    try {
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

      // The gateway has the turn: its stream started. A caller holding a queued
      // line may release it now — not because the call returned, but because the
      // work is the gateway's from here.
      options?.onAccepted?.(turnId);

      const adopted = response.headers?.get('x-versutus-session-id');
      if (adopted && adopted !== sessionId) options?.onSession?.(adopted);

      // One model report per distinct report: the same block rides every frame of
      // a turn, and a note per frame was a note per token.
      let lastModelReport: import('@/lib/gateway/run-failures').ModelReport | null = null;
      const frames = await readChatFrames({
        response,
        transport: this.transport,
        signal,
        callbacks: {
          onDelta,
          onToolCall: options?.onToolCall,
          onReasoning: options?.onReasoning,
          onTelemetryWarning: options?.onTelemetryWarning,
          onModelReport:
            options?.onModelReport &&
            ((report) => {
              if (
                lastModelReport !== null &&
                lastModelReport.requested === report.requested &&
                lastModelReport.ran === report.ran &&
                lastModelReport.provider === report.provider
              ) {
                return;
              }
              lastModelReport = report;
              options.onModelReport!(report);
            }),
        },
      });

      assertChatStreamComplete(frames.completed, frames.error, signal, frames.errorCode);
      return frames.text;
    } finally {
      // The turn is over however it ended, so the registry must not keep a
      // controller no request is listening to any more.
      this.pendingRuns.delete(turnId);
    }
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
   *
   * `options.timeoutMs` is the caller's own budget for a read it may walk away
   * from; without it the request inherits the transport's 30 s, which is also
   * the host's own read bound — a tap that has stopped waiting would otherwise
   * leave the read running behind it.
   */
  async rpcRequest<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
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
    return this.transport.request<T>(
      route.method,
      path,
      route.method === 'GET' ? undefined : body,
      options.timeoutMs,
    );
  }

  // ─── Run management ───────────────────────────────────────────

  private abortAllRuns() {
    for (const [, run] of this.pendingRuns) {
      run.abortController?.abort();
    }
    this.pendingRuns.clear();
  }

  /**
   * Cancel a turn server-side.
   *
   * A direct Hermes hosts no cancel route, and aborting the stream is the only
   * cancel it understands — so this is deliberately a no-op here. It exists so
   * the provider can call cancel without first asking what kind of gateway it
   * is holding.
   */
  async cancelTurn(_turnId: string): Promise<void> {
    // no server-side cancel on a stock Hermes
  }

  // ─── Utils ────────────────────────────────────────────────────

  private setStatus(status: ConnectionStatus, detail = '', info?: { authRejected?: boolean }) {
    this.status = status;
    this.detail = detail;
    this.callbacks.onStatus?.(status, detail, info);
  }
}
