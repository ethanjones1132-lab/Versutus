import { isAuthRejection } from '@/lib/gateway/errors';
import { gatewayRootUrl } from '@/lib/gateway/gateway-origin';
import { HttpTransport } from '@/lib/gateway/http-transport';
import { ConnectionMonitor, HEALTH_INTERVAL_MS } from '@/lib/gateway/connection-monitor';
import { streamingFetch } from '@/lib/net/streaming-fetch';
import type { GatewayIdentity } from '@/lib/portal/identify';
import type { GatewayBackend } from '@/lib/portal/manifest';
import type { PortalClient, PortalClientCallbacks } from '@/lib/portal/adapters';
import type {
  ConnectionStatus,
  GatewayCapabilities,
  GatewayProfile,
  HealthResponse,
  HermesSession,
  ModelInfo,
  SessionMessage,
  RunEvent,
  RunResponse,
  RunStatus,
  SessionMessagePage,
  SessionMessagesResponse,
  SessionsResponse,
} from '@/lib/gateway/types';

function interpolatePath(path: string, vars: Record<string, string>): string {
  return path.replace(/\{(\w+)\}|:(\w+)/g, (_match, named?: string, colon?: string) => {
    const key = named ?? colon ?? '';
    return vars[key] ?? '';
  });
}

/**
 * A PortalClient for any gateway that serves the Open Gateway Manifest and
 * has no built-in adapter (spec: docs/superpowers/specs/2026-08-10-versutus-gate-design.md §7).
 * Every route comes from `identity.manifest.endpoints` — never a hardcoded
 * Hermes path — so a conforming gate works here with zero app-side code
 * specific to it. A capability the manifest doesn't advertise fails with a
 * named error rather than guessing at a path that may not exist.
 */
export class ManifestClient implements PortalClient {
  private closed = false;
  private status: ConnectionStatus = 'disconnected';
  private detail = '';
  private currentSessionId: string | undefined;
  private selectedBackendId: string | undefined;
  private lastHealthError: string | null = null;
  private transport: HttpTransport;
  private rootTransport: HttpTransport;
  private monitor: ConnectionMonitor;
  private endpoints: Record<string, string>;

  constructor(
    private profile: GatewayProfile,
    private identity: GatewayIdentity,
    private callbacks: PortalClientCallbacks = {},
  ) {
    this.endpoints = identity.manifest?.endpoints ?? {};
    this.transport = new HttpTransport({
      baseUrl: profile.url,
      token: profile.token,
      sessionKey: profile.sessionKey,
    });
    this.rootTransport = new HttpTransport({
      baseUrl: gatewayRootUrl(profile.url),
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
    this.transport.update({ baseUrl: profile.url, token: profile.token, sessionKey: profile.sessionKey });
    this.rootTransport.update({
      baseUrl: gatewayRootUrl(profile.url),
      token: profile.token,
      sessionKey: profile.sessionKey,
    });
  }

  /** The manifest-declared path for `name`, or throws a named error. */
  private requireEndpoint(name: string): string {
    const path = this.endpoints[name];
    if (!path) {
      throw new Error(`This gateway's manifest does not advertise a "${name}" endpoint.`);
    }
    return path;
  }

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
      throw error;
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
      // Prove the token by hitting an authenticated endpoint, mirroring
      // HermesGatewayClient's connect(): a manifest fetch alone is
      // unauthenticated, so it would never catch a rejected token.
      if (this.endpoints.models) await this.getModels();
    } catch (error) {
      if (isAuthRejection(error)) {
        this.monitor.suspend();
        const message = error instanceof Error ? error.message : String(error);
        this.setStatus('disconnected', message);
        throw error;
      }
      // A capability snapshot or model list failing otherwise doesn't block connect.
    }

    this.setStatus('connected');
    this.callbacks.onHello?.({ type: 'hello-ok', protocol: 1, server: { version: this.identity.version } });
    if (capabilities) this.callbacks.onCapabilities?.(capabilities);
    this.callbacks.onHealthCheck?.(true, health);
    this.monitor.noteConnected();
    this.monitor.start();
  }

  disconnect() {
    this.closed = true;
    this.monitor.stop();
    this.monitor.resume();
    if (this.currentSessionId) this.profile.sessionId = this.currentSessionId;
    this.setStatus('disconnected');
  }

  suspendReconnect() {
    this.monitor.suspend();
  }

  resumeReconnect() {
    this.monitor.resume();
    if (!this.closed && this.status !== 'connected') {
      void this.connect().catch(() => undefined);
    }
  }

  async healthCheck(timeoutMs = 12_000): Promise<HealthResponse | null> {
    // Missing endpoint must surface to connect() — not be swallowed as "null health".
    const path = this.requireEndpoint('health');
    try {
      const result = await this.transport.request<HealthResponse>('GET', path, undefined, timeoutMs);
      this.lastHealthError = null;
      return result;
    } catch (error) {
      this.lastHealthError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  async getModels(): Promise<ModelInfo[]> {
    const path = this.requireEndpoint('models');
    const result = await this.transport.request<{ data: ModelInfo[] }>('GET', path);
    return result.data;
  }

  /**
   * A manifest-driven gate has no separate live capabilities endpoint —
   * the manifest itself is the capability declaration. Synthesize the same
   * shape HermesGatewayClient reports so the rest of the app (capability
   * snapshot UI, dashboards) needs no gateway-kind branch.
   */
  async getCapabilities(): Promise<GatewayCapabilities> {
    const manifestCaps = this.identity.manifest?.capabilities ?? {};
    const endpointsRecord: Record<string, { method: string; path: string }> = {};
    for (const [name, path] of Object.entries(this.endpoints)) {
      const method = name === 'chat' || name === 'chat_completions' || name === 'runs' ? 'POST' : 'GET';
      endpointsRecord[name] = { method, path };
    }
    // Hermes-shaped aliases so buildCapabilitySnapshot needs no kind branch.
    // Gate manifests say `chat`; the snapshot historically matched `chat_completions`.
    if (endpointsRecord.chat && !endpointsRecord.chat_completions) {
      endpointsRecord.chat_completions = endpointsRecord.chat;
    }
    if (endpointsRecord.health && !endpointsRecord.health_detailed) {
      // health alone is enough for a diagnostics glance on a chat-only gate
    }

    const features: Record<string, boolean | string> = {};
    for (const [key, value] of Object.entries(manifestCaps)) {
      if (typeof value === 'boolean' || typeof value === 'string') {
        features[key] = value;
      }
    }
    if (features.chat === true && features.chat_completions === undefined) {
      features.chat_completions = true;
      features.chat_completions_streaming =
        features.streaming === true || features.streaming === undefined;
    }
    if (features.runs === true && features.run_submission === undefined) {
      features.run_submission = true;
    }
    if (features.sessions === true && features.session_resources === undefined) {
      features.session_resources = true;
    }
    if (features.approvals === true && features.run_approval_response === undefined) {
      features.run_approval_response = true;
    }

    return {
      object: 'manifest-derived.capabilities',
      platform: this.identity.kindLabel,
      model: '',
      auth: { type: this.identity.auth.schemes[0] ?? 'bearer', required: this.identity.auth.requiresToken },
      runtime: {
        mode: 'gate',
        tool_execution: 'remote',
        split_runtime: false,
        description: this.identity.name ?? '',
      },
      features,
      endpoints: endpointsRecord,
      ...(Array.isArray(this.identity.manifest?.rpcMethods)
        ? { rpcMethods: this.identity.manifest.rpcMethods.filter((m): m is string => typeof m === 'string') }
        : {}),
    };
  }

  /** First model this gate advertises, if any. */
  private defaultModelId(): string | undefined {
    const fromProviders = this.identity.providers?.[0]?.models?.[0];
    if (typeof fromProviders === 'string' && fromProviders) return fromProviders;
    const fromManifest = this.identity.manifest?.providers?.[0]?.models?.[0];
    if (typeof fromManifest === 'string' && fromManifest) return fromManifest;
    return undefined;
  }

  async streamChat(
    messages: { role: string; content: string }[],
    onDelta: (text: string) => void,
    options?: {
      model?: string;
      /** Owning provider, when known — disambiguates a model id declared by more than one. */
      providerId?: string;
      sessionId?: string;
      signal?: AbortSignal;
      onToolCall?: (tool: import('@/lib/gateway/types').ChatToolCall) => void;
    },
  ): Promise<string> {
    const path = this.requireEndpoint('chat');
    const backendId = this.backendId;
    const model = options?.model || this.defaultModelId();
    // A backend supplies its own model catalog and default, so a turn routed to
    // one does not need the app to have picked a model first.
    if (!model && !backendId) {
      throw new Error(
        `${this.identity.kindLabel} has no model selected and advertises none. Pick a model or configure a provider.`,
      );
    }
    const body: Record<string, unknown> = { messages, stream: true };
    if (model) body.model = model;
    if (backendId) {
      body.backendId = backendId;
      // The native session holds the history; without it every turn is orphaned.
      const sessionId = options?.sessionId ?? this.currentSessionId;
      if (sessionId) body.sessionId = sessionId;
    } else if (options?.providerId) {
      // Unqualified, the Gate refuses to guess between providers that declare
      // the same model id (409 ambiguous_model) — a backend owns its catalog
      // outright, so this only applies to the provider-routed path.
      body.providerId = options.providerId;
    }

    const controller = new AbortController();
    const signal = options?.signal || controller.signal;

    const response = await streamingFetch(`${this.transport.baseUrl}${path}`, {
      method: 'POST',
      headers: this.transport.headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(errorText || `HTTP ${response.status}`);
    }

    let fullText = '';
    // A failed turn arrives as an error frame inside an HTTP 200 stream, so
    // response.ok above cannot catch it. Ignoring the frame renders an empty
    // assistant bubble with nothing to explain it — the exact silent failure
    // this stream was changed to stop producing. Captured here rather than
    // thrown, because the handler's own catch would swallow a throw.
    let streamError: string | null = null;
    const toolNames = new Map<number, string>();
    await this.transport.streamSSE(
      response,
      (data) => {
        try {
          const chunk = JSON.parse(data);
          if (chunk?.error) {
            const reported = chunk.error?.message;
            streamError =
              typeof reported === 'string' && reported
                ? reported
                : `The gateway reported a failed turn (${chunk.error?.code ?? 'unknown'}).`;
            return;
          }
          const delta = chunk?.choices?.[0]?.delta;
          const content = delta?.content;
          if (content) {
            fullText += content;
            onDelta(content);
          }
          const toolCalls = delta?.tool_calls;
          if (Array.isArray(toolCalls) && options?.onToolCall) {
            for (const call of toolCalls) {
              const index = typeof call?.index === 'number' ? call.index : 0;
              const namePart = call?.function?.name;
              if (typeof namePart === 'string' && namePart) {
                toolNames.set(index, (toolNames.get(index) ?? '') + namePart);
                options.onToolCall({ name: toolNames.get(index)!, status: 'running' });
              }
            }
          }
        } catch {
          // ignore malformed chunks — matches HermesGatewayClient's streamChat
        }
      },
      signal,
    );

    if (streamError) throw new Error(streamError);
    return fullText;
  }

  /** Native environments this gate can hold a conversation through. */
  get backends(): GatewayBackend[] {
    return this.identity.manifest?.backends ?? [];
  }

  /** The backend sessions and chat are scoped to; the first unless chosen. */
  get backendId(): string | undefined {
    return this.selectedBackendId ?? this.backends[0]?.id;
  }

  setBackendId(id: string | undefined) {
    this.selectedBackendId = id;
  }

  /** Append backendId so a multi-environment gate knows which one is meant. */
  private withBackend(path: string): string {
    const backendId = this.backendId;
    if (!backendId) return path;
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}backendId=${encodeURIComponent(backendId)}`;
  }

  async getSessions(limit = 20): Promise<HermesSession[]> {
    const path = this.endpoints.sessions;
    if (!path) {
      throw new Error(
        `${this.identity.kindLabel} does not advertise session management. This gate has no /api/sessions-style endpoint declared in its manifest.`,
      );
    }
    const separator = path.includes('?') ? '&' : '?';
    const result = await this.rootTransport.request<SessionsResponse | HermesSession[]>(
      'GET',
      this.withBackend(`${path}${separator}limit=${limit}`),
    );
    return Array.isArray(result) ? result : result.data ?? [];
  }

  /**
   * Sessions live in the backend, so creation is only offered when one is
   * attached — the app hides the control rather than failing at the tap.
   */
  async createSession(title?: string): Promise<HermesSession> {
    const path = this.requireEndpoint('sessions');
    return this.rootTransport.request<HermesSession>('POST', path, {
      ...(this.backendId ? { backendId: this.backendId } : {}),
      ...(title ? { title } : {}),
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    const path = this.requireEndpoint('sessions');
    await this.rootTransport.request<unknown>(
      'DELETE',
      this.withBackend(`${path.replace(/\/+$/, '')}/${encodeURIComponent(sessionId)}`),
    );
  }

  async getSessionMessages(sessionId: string, limit = 50): Promise<SessionMessage[]> {
    return (await this.getSessionMessagePage(sessionId, limit)).messages;
  }

  /**
   * One page of history, oldest-first, ending just before `before`.
   *
   * The array-returning `getSessionMessages` cannot express "the page before
   * this one", which forced callers to re-fetch the whole window with an
   * ever-larger limit. Gateways that do not report `hasMore`/`nextBefore` leave
   * those undefined, and the caller keeps its short-page heuristic.
   */
  async getSessionMessagePage(
    sessionId: string,
    limit = 50,
    before?: string,
  ): Promise<SessionMessagePage> {
    const template = this.endpoints.sessionMessages;
    const sessions = this.endpoints.sessions;
    if (!template && !sessions) {
      throw new Error(
        `${this.identity.kindLabel} does not advertise session management, so message history is unavailable. This gate has no sessions endpoint declared in its manifest.`,
      );
    }
    const path = template
      ? interpolatePath(template, { id: sessionId, sessionId })
      : `${sessions!.replace(/\/+$/, '')}/${sessionId}/messages`;
    const separator = path.includes('?') ? '&' : '?';
    const query = `limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
    const result = await this.rootTransport.request<SessionMessagesResponse | SessionMessage[]>(
      'GET',
      this.withBackend(`${path}${separator}${query}`),
    );

    if (Array.isArray(result)) return { messages: result };
    return {
      messages: result.data ?? [],
      hasMore: result.hasMore,
      nextBefore: result.nextBefore,
    };
  }

  /**
   * Generic capability RPC. A gate that advertises `capabilitiesRpc` can
   * answer both its built-in `registry.*` methods and anything its capability
   * instances contribute (design spec §6/§8). A gate that doesn't advertise it
   * keeps the old named error rather than guessing at a path.
   */
  async rpcRequest<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const path = this.endpoints.capabilitiesRpc;
    if (!path) {
      throw new Error(
        `${method} is not supported by ${this.identity.kindLabel} — it only advertises: ${Object.keys(this.endpoints).join(', ') || 'nothing'}.`,
      );
    }

    const body = await this.rootTransport.request<{
      result?: T;
      error?: { message?: string; code?: string };
    }>('POST', path, { method, params });

    if (body?.error) {
      throw new Error(body.error.message ?? `${method} failed on ${this.identity.kindLabel}.`);
    }
    return body?.result as T;
  }

  /**
   * Authenticated fetch against the gateway root. Runs live under the root
   * origin even for a child /p/{id} profile, so rootTransport is correct here.
   */
  async authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = { ...this.rootTransport.headers, ...((init.headers as Record<string, string>) ?? {}) };
    // The transport sets JSON by default; a GET/SSE request should not claim one.
    if (!init.body) delete headers['Content-Type'];
    return fetch(`${this.rootTransport.baseUrl}${path}`, { ...init, headers });
  }

  /**
   * Agentic runs, when the gateway advertises them.
   *
   * A Gate fronting Hermes serves the same paths Hermes does, so these are the
   * shapes the app already parses. A gateway that advertises no `runs` endpoint
   * throws rather than guessing a path — the Activity screen keys off the
   * capability, so it never calls these on a gateway without them.
   */
  async startRun(
    prompt: string,
    options?: { sessionId?: string; model?: string },
  ): Promise<RunResponse> {
    const runs = this.requireRunsEndpoint();
    const body: Record<string, unknown> = { input: prompt };
    if (options?.sessionId) body.session_id = options.sessionId;
    if (options?.model) body.model = options.model;
    return this.rootTransport.request<RunResponse>('POST', this.withBackend(runs), body);
  }

  async getRunStatus(runId: string): Promise<RunStatus> {
    const template = this.endpoints.runStatus;
    const path = template
      ? interpolatePath(template, { id: runId, runId, run_id: runId })
      : `${this.requireRunsEndpoint().replace(/\/+$/, '')}/${runId}`;
    return this.rootTransport.request<RunStatus>('GET', path);
  }

  async streamRunEvents(
    runId: string,
    onEvent: (event: RunEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const template = this.endpoints.runEvents;
    const path = template
      ? interpolatePath(template, { id: runId, runId, run_id: runId })
      : `${this.requireRunsEndpoint().replace(/\/+$/, '')}/${runId}/events`;

    const response = await streamingFetch(`${this.rootTransport.baseUrl}${path}`, {
      headers: this.rootTransport.headers,
      signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    await this.rootTransport.streamSSE(
      response,
      (data) => {
        try {
          onEvent(JSON.parse(data) as RunEvent);
        } catch {
          // A malformed frame must not kill the stream.
        }
      },
      signal,
    );
  }

  async resolveApproval(runId: string, approved: boolean, feedback?: string): Promise<void> {
    const template = this.endpoints.runApproval;
    const path = template
      ? interpolatePath(template, { id: runId, runId, run_id: runId })
      : `${this.requireRunsEndpoint().replace(/\/+$/, '')}/${runId}/approval`;
    await this.rootTransport.request<unknown>('POST', path, {
      approved,
      ...(feedback ? { feedback } : {}),
    });
  }

  private requireRunsEndpoint(): string {
    const runs = this.endpoints.runs;
    if (!runs) {
      throw new Error(
        `${this.identity.kindLabel} does not advertise agentic runs, so a run cannot be started here.`,
      );
    }
    return runs;
  }

  async stopRun(runId: string): Promise<void> {
    const template = this.endpoints.stopRun;
    const runs = this.endpoints.runs;
    if (!template && !runs) {
      throw new Error(
        `${this.identity.kindLabel} does not advertise run management, so a run cannot be stopped remotely.`,
      );
    }
    const path = template
      ? interpolatePath(template, { id: runId, runId })
      : `${runs!.replace(/\/+$/, '')}/${runId}/stop`;
    await this.rootTransport.request<unknown>('POST', path, {});
  }

  private setStatus(status: ConnectionStatus, detail = '') {
    this.status = status;
    this.detail = detail;
    this.callbacks.onStatus?.(status, detail);
  }
}
