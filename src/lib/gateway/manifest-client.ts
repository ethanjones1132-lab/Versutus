import type { PublicBot } from '@/lib/gateway/bots';
import type { ChatContentPart } from '@/lib/gateway/chat-parts';
import type { CronJob, CronRun, CronTurn } from '@/lib/gateway/cron';
import type { BotGroupRoom, GroupReply, GroupTranscriptEntry, GroupTurnError } from '@/lib/gateway/groups';
import { HEALTH_CHECK_TIMEOUT_MS, CANCEL_TURN_TIMEOUT_MS, createTurnId } from '@/lib/gateway/client';
import { isAuthRejection } from '@/lib/gateway/errors';
import { gatewayRootUrl } from '@/lib/gateway/gateway-origin';
import { withGetSessionsRetry } from '@/lib/gateway/get-sessions-retry';
import { errorCodeFromHttpBody, messageFromHttpErrorBody } from '@/lib/gateway/http-error-body';
import { advertisedIpv4 } from '@/lib/gateway/host-lookup';
import { HttpTransport, assertChatStreamComplete } from '@/lib/gateway/http-transport';
import { GatewayRpcError, rpcParamsWithScope } from '@/lib/gateway/rpc-scope';
import { ConnectionMonitor, hasRecentContact } from '@/lib/gateway/connection-monitor';
import {
  readChatFrames,
  turnFromMeta,
  turnsFromListEnvelope,
  type TurnEventStreamOptions,
  type TurnListFilter,
  type TurnMeta,
  type TurnStreamResult,
} from '@/lib/gateway/turns';
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

/** How long authorizedFetch waits for response headers before aborting. */
const AUTHORIZED_FETCH_HEADER_TIMEOUT_MS = 60_000;

/**
 * How long the phone waits for one group round. A send runs the whole planned
 * round-robin server-side and only answers with the slowest member (the Gate's
 * own per-speaker ceiling is 90 s), so the transport's 30 s default aborted a
 * perfectly healthy round the Gate was still running. The bound is deliberately
 * past any round the Gate can complete; Council's own 120 s screen bound still
 * settles the UI first.
 */
export const GROUP_SEND_TIMEOUT_MS = 600_000;

/** How long the connect-time auth proof waits before it stops asking. */
const AUTH_PROBE_TIMEOUT_MS = 10_000;

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
  /**
   * Bumped by disconnect(). An attemptConnect that started under an older
   * epoch is talking to a gateway the provider has already discarded, so
   * every await it resumes from has to be able to tell.
   */
  private connectEpoch = 0;
  private authRejectedState = false;
  private status: ConnectionStatus = 'disconnected';
  private detail = '';
  private currentSessionId: string | undefined;
  private selectedBackendId: string | undefined;
  private selectedBotId: string | undefined;
  /**
   * Turns streaming right now, by the turn id the request was sent under.
   *
   * `disconnect()` is the only teardown this client offers, so it is the only
   * place a discarded client can stop the stream it is still reading. Without
   * this the phone kept taking frames for a thread it had left, and the socket
   * stayed open on the Gate for the rest of the turn.
   */
  private readonly pendingRuns = new Map<string, { runId: string; abortController: AbortController }>();
  private lastHealthError: string | null = null;
  /** Latched once a `/v1/turns` read is answered 404 by this gateway. */
  private turnsMissing = false;
  private transport: HttpTransport;
  private rootTransport: HttpTransport;
  private monitor: ConnectionMonitor;
  private endpoints: Record<string, string>;
  private connectAttempt: Promise<void> | null = null;

  constructor(
    private profile: GatewayProfile,
    private identity: GatewayIdentity,
    private callbacks: PortalClientCallbacks = {},
  ) {
    this.endpoints = identity.manifest?.endpoints ?? {};
    const alternateIpv4 = advertisedIpv4({
      advertised: identity.manifest?.transport?.ipv4,
      configuredHosts: profile.alternateIpv4,
    });
    this.transport = new HttpTransport({
      baseUrl: profile.url,
      token: profile.token,
      sessionKey: profile.sessionKey,
      alternateIpv4,
      // A timed-out request, a refused connection or a stalled stream is
      // evidence of a dead path the 30s interval cannot act on for half a
      // minute more. Hand it to the monitor instead: two quick probes reach
      // `reconnecting` in ~2s.
      onNetworkTrouble: (reason) => this.nudge(reason),
    });
    this.rootTransport = new HttpTransport({
      baseUrl: gatewayRootUrl(profile.url),
      token: profile.token,
      sessionKey: profile.sessionKey,
      alternateIpv4,
      // Every real answer lands on this transport, so it carries the hook too.
      onNetworkTrouble: (reason) => this.nudge(reason),
    });
    this.monitor = new ConnectionMonitor({
      probe: async () => (await this.healthCheck()) !== null,
      // Both transports carry evidence: the profile-scoped transport only
      // ever serves /health here, while every real answer (models, bots,
      // groups, sessions, jobs, runs) lands on the root transport. Watching
      // the profile transport alone made recentlyServedUs blind to all of
      // it, so a gate busy enough to stall /health got declared down
      // mid-session even while it kept answering the phone.
      recentlyServedUs: () =>
        hasRecentContact(
          Math.max(this.transport.lastContactAt, this.rootTransport.lastContactAt),
          Date.now(),
        ),
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
   * True while the last disconnect was the gate refusing our credentials.
   * The provider's onStatus handler sees that status before the connect()
   * rejection reaches it, so without this signal it cannot tell "wrong token"
   * from "gate down" and schedules a retry that can never succeed.
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
    const alternateIpv4 = advertisedIpv4({
      advertised: this.identity.manifest?.transport?.ipv4,
      configuredHosts: profile.alternateIpv4,
    });
    this.transport.update({
      baseUrl: profile.url,
      token: profile.token,
      sessionKey: profile.sessionKey,
      alternateIpv4,
      // update() REPLACES the whole option set, so the hook has to be restated
      // here or the first profile change silently drops trouble reporting.
      onNetworkTrouble: (reason) => this.nudge(reason),
    });
    this.rootTransport.update({
      baseUrl: gatewayRootUrl(profile.url),
      token: profile.token,
      sessionKey: profile.sessionKey,
      alternateIpv4,
      onNetworkTrouble: (reason) => this.nudge(reason),
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

  /**
   * Up-front capability verdicts read straight off the document this client
   * was built from — no call, no throw. The provider probes them when the
   * client is installed so creation affordances hide themselves on gateways
   * that would only refuse after their sheet is filled.
   */
  get canManageBots(): boolean {
    return Boolean(this.endpoints.bots);
  }

  get canManageGroups(): boolean {
    return Boolean(this.endpoints.botGroups);
  }

  get canManageSessions(): boolean {
    return Boolean(this.endpoints.sessions);
  }

  /**
   * Concurrent callers join the attempt already in flight rather than stack
   * a duplicate one: resumeReconnect() and the monitor's reconnect hook can
   * both fire while an earlier connect() is still awaiting health, models,
   * or capabilities, and each duplicate re-fetched everything and raced its
   * sibling through the status machine. The handle clears once settled, so
   * a connect() after a real failure starts fresh.
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
      throw error;
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
      if (this.connectEpoch !== epoch) return;
      // Prove the token by hitting an authenticated endpoint, mirroring
      // HermesGatewayClient's connect(): a manifest fetch alone is
      // unauthenticated, so it would never catch a rejected token.
      await this.probeAuth();
      if (this.connectEpoch !== epoch) return;
    } catch (error) {
      if (this.connectEpoch !== epoch) return;
      if (isAuthRejection(error)) {
        this.monitor.suspend();
        this.authRejectedState = true;
        const message = error instanceof Error ? error.message : String(error);
        this.setStatus('disconnected', message, { authRejected: true });
        throw error;
      }
      // A capability snapshot or model list failing otherwise doesn't block connect.
    }
    if (this.connectEpoch !== epoch) return;

    this.authRejectedState = false;
    this.setStatus('connected');
    this.callbacks.onHello?.({ type: 'hello-ok', protocol: 1, server: { version: this.identity.version } });
    if (capabilities) this.callbacks.onCapabilities?.(capabilities);
    this.callbacks.onHealthCheck?.(true, health);
    this.monitor.noteConnected();
    this.monitor.start();
  }

  disconnect() {
    this.connectEpoch += 1;
    this.closed = true;
    this.monitor.stop();
    // A turn still streaming belongs to the client being discarded: stop it here
    // rather than leaving frames arriving for a thread this phone has left.
    for (const [, run] of this.pendingRuns) run.abortController.abort();
    this.pendingRuns.clear();
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

  async healthCheck(timeoutMs = HEALTH_CHECK_TIMEOUT_MS): Promise<HealthResponse | null> {
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
    const result = await this.rootTransport.request<unknown>('GET', this.withScope(path));
    // A transitional or malformed gate answer must not escape as a non-list
    // and poison picker state: only a real catalog (a bare array or a
    // { data: [...] } envelope) reaches the caller; anything else is empty.
    if (Array.isArray(result)) return result;
    if (result && typeof result === 'object' && Array.isArray((result as { data?: unknown }).data)) {
      return (result as { data: ModelInfo[] }).data;
    }
    return [];
  }

  /**
   * "Is this token accepted?", and nothing else.
   *
   * `getModels()` used to answer that, but on a Gate `/v1/models` aggregates
   * every provider and every backend and can start backends to do it — a whole
   * catalogue read on the critical path of every connect to ask a yes/no the
   * cheapest advertised route answers identically. So the proof goes to
   * `environments`, then `providers`, and only falls back to the catalogue for a
   * manifest that advertises neither. The answer is discarded: this is a
   * verdict on the key, not data.
   */
  private async probeAuth(): Promise<void> {
    const path = this.endpoints.environments ?? this.endpoints.providers ?? this.endpoints.models;
    if (!path) return;
    await this.rootTransport.request<unknown>('GET', path, undefined, AUTH_PROBE_TIMEOUT_MS);
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
    messages: { role: string; content: string | ChatContentPart[] }[],
    onDelta: (text: string) => void,
    options?: {
      model?: string;
      /** Owning provider, when known — disambiguates a model id declared by more than one. */
      providerId?: string;
      sessionId?: string;
      signal?: AbortSignal;
      onToolCall?: (tool: import('@/lib/gateway/types').ChatToolCall) => void;
      onReasoning?: (text: string) => void;
      onTelemetryWarning?: (message: string) => void;
      /** Which model actually served the turn, once the Gate reports it. */
      onModelReport?: (report: import('@/lib/gateway/run-failures').ModelReport) => void;
      /** The turn id sent with the request, so a cancel can name it. */
      onTurnId?: (turnId: string) => void;
      /**
       * The id to send under, when the caller minted this line's turn already.
       * A queued line reuses its own, so a resend the Gate already took comes
       * back as a replay of the same turn rather than a second one.
       */
      turnId?: string;
      /** The Gate accepted the turn: its stream started, or it replayed it. */
      onAccepted?: (turnId: string) => void;
      /** A session the Gate adopted for the turn, when it reports one. */
      onSession?: (sessionId: string) => void;
    },
  ): Promise<string> {
    const path = this.requireEndpoint('chat');
    const backendId = this.backendId;
    const model = options?.model || this.defaultModelId();
    // A backend supplies its own model catalog and default, so a turn routed to
    // one does not need the app to have picked a model first. When the Gate
    // advertises backends but none was chosen, the turn goes unpinned and the
    // Gate resolves the environment — the backend still owns its default.
    if (!model && !backendId && this.backends.length === 0) {
      throw new Error(
        `${this.identity.kindLabel} has no model selected and advertises none. Pick a model or configure a provider.`,
      );
    }
    const body: Record<string, unknown> = { messages, stream: true };
    if (model) body.model = model;
    const sentSessionId = options?.sessionId ?? this.currentSessionId;
    if (backendId || this.botId) {
      // A Bot names its own environment (see withScope) — naming the thread's
      // backend too would send the turn to an environment with no Bots.
      if (this.botId) body.bot = this.botId;
      else body.backendId = backendId;
      // The native session holds the history; without it every turn is orphaned.
      if (sentSessionId) body.sessionId = sentSessionId;
    } else if (options?.providerId) {
      // Unqualified, the Gate refuses to guess between providers that declare
      // the same model id (409 ambiguous_model) — a backend owns its catalog
      // outright, so this only applies to the provider-routed path.
      body.providerId = options.providerId;
    }

    // Named before the request so a caller can cancel the turn even if the
    // POST itself never lands. The Gate correlates the streamed chat with this
    // id for the server-side cancel — and keys the turn's journal by it, which
    // is why a caller that already minted one passes it in: every resend of a
    // queued line has to be the same turn, not a second one.
    const turnId = options?.turnId ?? createTurnId();
    options?.onTurnId?.(turnId);

    const controller = new AbortController();
    // A caller-owned signal is wired INTO this controller rather than used
    // instead of it, so the one signal the request runs under is always one the
    // in-flight registry holds — otherwise `disconnect()` could not stop a turn
    // whose signal belonged to the provider, which is every turn the app sends.
    const callerSignal = options?.signal;
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const signal = controller.signal;
    // Registered for the whole life of the turn, so a client that is discarded
    // mid-stream stops the stream instead of leaving it reading for a thread the
    // phone has left.
    this.pendingRuns.set(turnId, { runId: turnId, abortController: controller });

    try {
      const response = await streamingFetch(`${this.transport.baseUrl}${path}`, {
        method: 'POST',
        headers: { ...this.transport.headers, 'X-Versutus-Turn-Id': turnId },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        // The body is a JSON envelope. Throwing it verbatim is what put
        // `{"error":{"message":"hermes: 500 …","code":"backend_error"}}` inside an
        // assistant bubble on 2026-08-26 — wire text presented as if the model had
        // said it, in the banner as well. Every other call site in this file
        // already unwraps through the same helper.
        const errorText = await response.text().catch(() => '');
        throw new Error(messageFromHttpErrorBody(errorText, response.status));
      }

      // The Gate has the turn now, whichever way it answered: HTTP 200 opened a
      // new turn, and the same id again is a replay of the one already journaled.
      // A turn that ends here belongs to the Gate, so the caller's outbox may
      // release the line it was holding.
      options?.onAccepted?.(turnId);

      // A turn the Gate opened for itself names its thread in the response, so
      // the app can keep writing to the same session instead of forking a new
      // one on every send.
      const adopted = response.headers?.get('x-versutus-session-id');
      if (adopted && adopted !== sentSessionId) options?.onSession?.(adopted);

      const frames = await readChatFrames({
        response,
        transport: this.transport,
        signal,
        callbacks: {
          onDelta,
          onToolCall: options?.onToolCall,
          onReasoning: options?.onReasoning,
          onTelemetryWarning: options?.onTelemetryWarning,
          // The model asked for is what this send requested, so a report that
          // names only what ran still says what it was instead of.
          onModelReport: options?.onModelReport
            ? (report) => options.onModelReport!({ ...report, requested: report.requested ?? options?.model })
            : undefined,
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

  /** Native environments this gate can hold a conversation through. */
  get backends(): GatewayBackend[] {
    return this.identity.manifest?.backends ?? [];
  }

  /**
   * The backend an operator has explicitly chosen for this conversation; nothing
   * until one is picked. A default here is a silent pin: on a four-environment
   * Gate it was whichever advertised first (usually Claude Code), and the Gate
   * answered 501 for the surfaces that environment does not implement. Leaving
   * the route unpinned lets the Gate resolve it by capability.
   */
  get backendId(): string | undefined {
    return this.selectedBackendId;
  }

  setBackendId(id: string | undefined) {
    this.selectedBackendId = id;
  }

  get botId(): string | undefined {
    return this.selectedBotId;
  }

  setBotId(id: string | undefined) {
    this.selectedBotId = id || undefined;
  }

  /** Append backendId so a multi-environment gate knows which one is meant. */
  private withBackend(path: string): string {
    const backendId = this.backendId;
    if (!backendId) return path;
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}backendId=${encodeURIComponent(backendId)}`;
  }

  private withBot(path: string): string {
    const botId = this.botId;
    if (!botId) return path;
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}bot=${encodeURIComponent(botId)}`;
  }

  /**
   * Scope a conversation or run route.
   *
   * A Bot names its own environment — it is a Hermes profile, and the Gate
   * resolves `bot=` to the environment that actually has Bots. Sending the
   * thread's chat backend alongside it overrode that with a deliberate pin,
   * usually onto Claude Code, and the Gate answered 501 "This backend does
   * not implement bots": tapping an agent bounced straight back to the
   * roster. With no Bot selected the chosen environment is exactly right —
   * that is what configurable chat means.
   *
   * Runs follow the same rule: the connect path auto-adopts a configurable-
   * chat backend (gateway-provider), and opening a Bot Chat keeps it — so
   * appending it to a Bot-scoped run pinned every Bot run onto the
   * environment that cannot run a Bot at all. A deliberate environment pick
   * clears the Bot (selectBackend), so a Bot set means the Bot names the
   * environment and the inherited backend has no say.
   */
  private withScope(path: string): string {
    return this.botId ? this.withBot(path) : this.withBackend(path);
  }

  /**
   * Bot and routine surfaces are Gate-level, not thread-level.
   *
   * A Bot is a Hermes profile (CONTEXT.md); Claude Code, Codex and OpenCode
   * are not Bots and cannot inventory them. The Gate already resolves these
   * routes by capability — but only for a caller that names no backend, since
   * an explicit `?backendId=` is treated as a deliberate pin. `backendId`
   * defaults to `backends[0]`, which on a four-environment Gate is Claude
   * Code, so every bots/jobs call arrived pinned to the one environment that
   * could not serve it and came back 501 ("This backend does not implement
   * listBots") — the whole roster, from a Gate that had four Bots.
   *
   * So these paths carry the Bot scope and nothing else: the chat backend the
   * operator picked for *this thread* has no say in where the Bots live.
   */
  private withBotOnly(path: string): string {
    return this.withBot(path);
  }

  async handoffMention(input: { fromId: string; toId: string; text: string }): Promise<unknown> {
    const path = this.requireEndpoint('bots');
    return this.rootTransport.request('POST', `${path.replace(/\/+$/, '')}/handoff`, input);
  }

  async createBot(input: {
    name: string;
    soul?: string;
    inheritKeys?: boolean;
    description?: string;
    modelId?: string | null;
    providerId?: string | null;
  }): Promise<PublicBot> {
    const path = this.requireEndpoint('bots');
    return this.rootTransport.request('POST', path, input);
  }

  /**
   * Edit an existing Bot through the manifest-declared bots endpoint. Only
   * the fields present in `input` travel — the Gate leaves absent fields
   * untouched, while null explicitly clears a model pin.
   */
  async updateBot(input: {
    id: string;
    soul?: string;
    description?: string;
    modelId?: string | null;
    providerId?: string | null;
  }): Promise<PublicBot> {
    const path = this.requireEndpoint('bots');
    const body: Record<string, unknown> = {};
    if (input.soul !== undefined) body.soul = input.soul;
    if (input.description !== undefined) body.description = input.description;
    if (input.modelId !== undefined) body.modelId = input.modelId;
    if (input.providerId !== undefined) body.providerId = input.providerId;
    return this.rootTransport.request(
      'PATCH',
      `${path.replace(/\/+$/, '')}/${encodeURIComponent(input.id)}`,
      body,
    );
  }

  async listJobs(): Promise<{ id: string; name?: string; paused?: boolean }[]> {
    const path = this.endpoints.jobs;
    if (!path) return [];
    type JobRow = { id: string; name?: string; paused?: boolean };
    type JobEnvelope = { data?: JobRow[]; jobs?: JobRow[]; crons?: JobRow[]; items?: JobRow[] };
    const result = await this.rootTransport.request<JobEnvelope | JobRow[]>('GET', this.withBotOnly(path));
    if (Array.isArray(result)) return result;
    // Same key list formatCron reads (['data', 'jobs', 'crons', 'items']): a host
    // answering { jobs: [...] } must not read as empty in the Routines pane.
    for (const key of ['data', 'jobs', 'crons', 'items'] as const) {
      const rows = result[key];
      if (Array.isArray(rows)) return rows;
    }
    return [];
  }

  async createJob(input: { name: string; prompt: string; schedule: string }): Promise<{ id: string; name?: string }> {
    const path = this.requireEndpoint('jobs');
    return this.rootTransport.request('POST', this.withBotOnly(path), {
      ...input,
      ...(this.botId ? { bot: this.botId } : {}),
    });
  }

  async runJob(jobId: string): Promise<void> {
    const path = this.requireEndpoint('jobs');
    await this.rootTransport.request(
      'POST',
      this.withBotOnly(`${path.replace(/\/+$/, '')}/${encodeURIComponent(jobId)}/run`),
      this.botId ? { bot: this.botId } : {},
    );
  }

  async setJobPaused(jobId: string, paused: boolean): Promise<void> {
    const path = this.requireEndpoint('jobs');
    const action = paused ? 'pause' : 'resume';
    await this.rootTransport.request(
      'POST',
      this.withBotOnly(`${path.replace(/\/+$/, '')}/${encodeURIComponent(jobId)}/${action}`),
      this.botId ? { bot: this.botId } : {},
    );
  }

  /**
   * Destructive counterpart to setJobPaused. The Gate serves DELETE
   * /v1/jobs/{id} which resolves to `removeJob` on the backend; the
   * Hermes backend answers it with `DELETE /api/jobs/{id}`. A refused
   * remove throws and the caller surfaces the failure.
   */
  async removeJob(jobId: string): Promise<void> {
    const path = this.requireEndpoint('jobs');
    await this.rootTransport.request(
      'DELETE',
      this.withBotOnly(`${path.replace(/\/+$/, '')}/${encodeURIComponent(jobId)}`),
      this.botId ? { bot: this.botId } : {},
    );
  }

  /**
   * Cron transparency. The Gate joins the job record, its latest execution and
   * the sessions its runs wrote; the phone never learns how the host spells a
   * cron session id. A gateway with no cron backend answers with the RPC's own
   * refusal, which the caller surfaces rather than swallowing.
   */
  async listCronJobs(): Promise<CronJob[]> {
    const result = await this.rpcRequest<{ data?: CronJob[] }>('cron.jobs');
    return result?.data ?? [];
  }

  async cronRuns(jobId: string): Promise<CronRun[]> {
    const result = await this.rpcRequest<{ data?: CronRun[] }>('cron.runs', { jobId });
    return result?.data ?? [];
  }

  async cronTranscript(runId: string, limit?: number): Promise<CronTurn[]> {
    const result = await this.rpcRequest<{ data?: CronTurn[] }>('cron.transcript', {
      runId,
      ...(limit ? { limit } : {}),
    });
    return result?.data ?? [];
  }

  async listBots(): Promise<PublicBot[]> {
    const path = this.endpoints.bots;
    if (!path) return [];
    const result = await this.rootTransport.request<{ data?: PublicBot[] } | PublicBot[]>('GET', path);
    return Array.isArray(result) ? result : result.data ?? [];
  }

  /**
   * Group rooms are Gate-level (shared across environments), so unlike bots
   * and jobs these calls carry no bot/backend scoping — the room store lives
   * in the Gate home, not behind a backend. A gate that does not advertise
   * `botGroups` simply has no rooms: list degrades to empty, the rest name
   * the missing capability through requireEndpoint.
   */
  async listGroups(): Promise<BotGroupRoom[]> {
    const path = this.endpoints.botGroups;
    if (!path) return [];
    const result = await this.rootTransport.request<{ data?: BotGroupRoom[] } | BotGroupRoom[]>('GET', path);
    return Array.isArray(result) ? result : result.data ?? [];
  }

  async createGroup(input: { name: string; memberIds: string[] }): Promise<BotGroupRoom> {
    const path = this.requireEndpoint('botGroups');
    return this.rootTransport.request<BotGroupRoom>('POST', path, input);
  }

  /**
   * One send runs the whole planned round-robin server-side and returns every
   * reply with its author, so a silent bot ends the plan early instead of
   * hanging the phone mid-round. `roomDisbanded` is set only when the room
   * was deleted between the send door and the transcript write — the replies
   * happened but nothing was stored, and the room is gone.
   */
  async sendGroupMessage(
    groupId: string,
    input: { text: string; mentionedIds?: string[] },
    timeoutMs: number = GROUP_SEND_TIMEOUT_MS,
  ): Promise<{ replies: GroupReply[]; errors?: GroupTurnError[]; roomDisbanded?: boolean }> {
    const path = this.requireEndpoint('botGroups');
    return this.rootTransport.request(
      'POST',
      `${path.replace(/\/+$/, '')}/${encodeURIComponent(groupId)}/messages`,
      input,
      timeoutMs,
    );
  }

  /**
   * The Gate keeps each room's transcript so a revisit replays the
   * conversation instead of starting blank. Gates without the rooms
   * capability degrade to empty, like listGroups does.
   */
  async groupHistory(groupId: string): Promise<GroupTranscriptEntry[]> {
    const path = this.endpoints.botGroups;
    if (!path) return [];
    const result = await this.rootTransport.request<{ data?: GroupTranscriptEntry[] } | GroupTranscriptEntry[]>(
      'GET',
      `${path.replace(/\/+$/, '')}/${encodeURIComponent(groupId)}/messages`,
    );
    return Array.isArray(result) ? result : result.data ?? [];
  }

  async renameGroup(groupId: string, name: string): Promise<BotGroupRoom> {
    const path = this.requireEndpoint('botGroups');
    return this.rootTransport.request(
      'PATCH',
      `${path.replace(/\/+$/, '')}/${encodeURIComponent(groupId)}`,
      { name },
    );
  }

  async leaveGroup(groupId: string, memberId: string): Promise<BotGroupRoom> {
    const path = this.requireEndpoint('botGroups');
    return this.rootTransport.request(
      'POST',
      `${path.replace(/\/+$/, '')}/${encodeURIComponent(groupId)}/leave`,
      { memberId },
    );
  }

  /**
   * Disbands a room: every member leaves and the stored transcript is
   * deleted on the Gate, so a disbanded room never resurfaces on the next
   * list. Gates without the rooms capability refuse like the other group
   * calls. The roster copy is authoritative after this returns.
   */
  async deleteGroup(groupId: string): Promise<{ ok: boolean }> {
    const path = this.requireEndpoint('botGroups');
    return this.rootTransport.request(
      'DELETE',
      `${path.replace(/\/+$/, '')}/${encodeURIComponent(groupId)}`,
    );
  }

  /**
   * Appends members to a room and returns the Gate's updated roster — the
   * same PATCH endpoint rename uses, carrying memberIds instead of a name.
   * Ids already in the room are skipped server-side; an add that names no
   * new member is refused there, and this surfaces that refusal.
   */
  async addGroupMembers(groupId: string, memberIds: string[]): Promise<BotGroupRoom> {
    const path = this.requireEndpoint('botGroups');
    return this.rootTransport.request(
      'PATCH',
      `${path.replace(/\/+$/, '')}/${encodeURIComponent(groupId)}`,
      { memberIds },
    );
  }

  /**
   * List sessions via the advertised GET path, with the same bounded retry
   * HermesGatewayClient uses. A missing path throws immediately — that is a
   * capability signal, not a blip, so it is not retried. `limit` also decides
   * the per-attempt budget: a bulk read is a different read.
   *
   * Delegates to `getSessionPage`, which is the read that keeps the gateway's
   * own verdict about the page; this keeps the row list and drops the verdict.
   */
  async getSessions(limit = 20): Promise<HermesSession[]> {
    return (await this.getSessionPage(limit)).sessions;
  }

  /**
   * One page of sessions, and whether the gateway says it is the whole window.
   *
   * The Gate marks a page `partial` when it could not finish the window it was
   * asked for and answered with what its own copy held. Dropping that flag is
   * what made a slow read read as "that is the whole catalogue": the app
   * compares rows against the limit it sent, and 20 rows for a 200 ask is
   * exactly the page that hides older threads. The flag is carried here so
   * completeness can be judged on the gateway's word rather than on the count.
   */
  async getSessionPage(limit = 20): Promise<{ sessions: HermesSession[]; partial?: boolean }> {
    const path = this.endpoints.sessions;
    if (!path) {
      throw new Error(
        `${this.identity.kindLabel} does not advertise session management. This gate has no /api/sessions-style endpoint declared in its manifest.`,
      );
    }
    const separator = path.includes('?') ? '&' : '?';
    const result = await withGetSessionsRetry(
      (timeoutMs) =>
        this.rootTransport.request<SessionsResponse | HermesSession[]>(
          'GET',
          this.withScope(`${path}${separator}limit=${limit}`),
          undefined,
          timeoutMs,
        ),
      { limit },
    );
    if (Array.isArray(result)) return { sessions: result };
    return { sessions: result.data ?? [], partial: result.partial };
  }

  /**
   * One Bot's own session catalogue, for the per-Bot spend read (P5).
   *
   * The app's other catalogue read cannot be scoped to a Bot: `sessions.list`
   * travels as `{ method, params }` to the Gate's RPC, which dispatches by
   * METHOD, so only `params.backendId` ever reaches the resolver. The Gate's
   * REST catalogue does carry one — it reads `?bot=` and resolves that Bot's
   * own Hermes profile — so this names the Bot in the query instead of taking
   * whatever `setBotId` holds. A read of one Bot must not move the app's
   * scope: `openBot` and the Bot Chat pinning both depend on it staying.
   *
   * `options.signal` is the spend fan-out's walk-away: it reaches the retry
   * ladder, so a Bot the operator stopped reading grows no further attempt.
   * The attempt already sent is still the Gate's to finish.
   */
  async listBotSessionCatalogue(
    botId: string,
    limit = 20,
    options: { signal?: AbortSignal } = {},
  ): Promise<HermesSession[]> {
    const path = this.endpoints.sessions;
    if (!path) {
      throw new Error(
        `${this.identity.kindLabel} does not advertise session management. This gate has no /api/sessions-style endpoint declared in its manifest.`,
      );
    }
    const separator = path.includes('?') ? '&' : '?';
    const query = `bot=${encodeURIComponent(botId)}&limit=${limit}`;
    const result = await withGetSessionsRetry(
      (timeoutMs) =>
        this.rootTransport.request<SessionsResponse | HermesSession[]>(
          'GET',
          `${path}${separator}${query}`,
          undefined,
          timeoutMs,
        ),
      { limit, signal: options.signal },
    );
    return Array.isArray(result) ? result : result.data ?? [];
  }

  /**
   * Sessions live in the backend, so creation is only offered when one is
   * attached — the app hides the control rather than failing at the tap.
   */
  /**
   * Opens a session, pinned to `model` when one is given.
   *
   * The model MUST travel with the create call: a Hermes session's model is
   * fixed at creation and `PATCH /api/sessions/{id}` refuses `model` outright,
   * so a session opened without one answers on the host's own default for its
   * whole life. That is what put an unrequested NVIDIA model on the first turn
   * of every thread and forced the operator to pick a model, watch the session
   * be released, and send again just to be heard.
   */
  async createSession(title?: string, model?: string): Promise<HermesSession> {
    const path = this.requireEndpoint('sessions');
    // Same rule as withScope: the Bot names the environment, so its own
    // chat must not be pinned to whichever backend the thread was using.
    return this.rootTransport.request<HermesSession>('POST', path, {
      ...(this.botId ? { bot: this.botId } : this.backendId ? { backendId: this.backendId } : {}),
      ...(title ? { title } : {}),
      // `{ modelId }` is the shape the Gate hands to backend.createSession.
      ...(model ? { model: { modelId: model } } : {}),
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    const path = this.requireEndpoint('sessions');
    await this.rootTransport.request<unknown>(
      'DELETE',
      this.withScope(`${path.replace(/\/+$/, '')}/${encodeURIComponent(sessionId)}`),
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
      : `${sessions!.replace(/\/+$/, '')}/${encodeURIComponent(sessionId)}/messages`;
    const separator = path.includes('?') ? '&' : '?';
    const query = `limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
    const result = await this.rootTransport.request<SessionMessagesResponse | SessionMessage[]>(
      'GET',
      this.withScope(`${path}${separator}${query}`),
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
   *
   * The thread's scope rides along on the methods that read a backend, exactly
   * as `withScope` puts it on the REST routes: without it the Gate resolved
   * `session.restore` against whichever environment sorts first, which is how a
   * Hermes session the operator could see in the sheet read as `Session not
   * found`. Gate-global methods (device.*, voice.*, registry.*, …) are left
   * exactly as the caller wrote them.
   *
   * `options.timeoutMs` is the caller's own budget for a read it may walk away
   * from — the thread-tap validation, which stops waiting at its own bound and
   * lets the switch proceed. Without it the request inherits the transport's
   * 30 s, which is the same number the Gate's own session read uses, so a tap
   * that has moved on leaves a read running on the Gate for the rest of it.
   */
  async rpcRequest<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    const path = this.endpoints.capabilitiesRpc;
    if (!path) {
      throw new Error(
        `${method} is not supported by ${this.identity.kindLabel} — it only advertises: ${Object.keys(this.endpoints).join(', ') || 'nothing'}.`,
      );
    }

    const body = await this.rootTransport.request<{
      result?: T;
      error?: { message?: string; code?: string };
    }>('POST', path, {
      method,
      params: rpcParamsWithScope(method, params, { backendId: this.backendId, botId: this.botId }),
    }, options.timeoutMs);

    if (body?.error) {
      // The gate's own code travels on the thrown Error: `unknown_session` is
      // the one refusal a thread tap acts on, and it is indistinguishable from
      // every other failure while the code is dropped here.
      throw new GatewayRpcError(
        body.error.message ?? `${method} failed on ${this.identity.kindLabel}.`,
        body.error.code,
      );
    }
    return body?.result as T;
  }

  /**
   * Authenticated fetch against the gateway root. Runs live under the root
   * origin even for a child /p/{id} profile, so rootTransport is correct here.
   *
   * This is the CLI-environment run transport — including the SSE event stream
   * (`GET /v1/environments/{id}/runs/{runId}/events`) — so it must go through
   * streamingFetch: React Native's global fetch has no readable response body,
   * and a plain-fetch stream silently delivers zero events on device while
   * every Node-side test stays green. See streaming-fetch.ts.
   */
  async authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = { ...this.rootTransport.headers, ...((init.headers as Record<string, string>) ?? {}) };
    // The transport sets JSON by default; a GET/SSE request should not claim one.
    if (!init.body) delete headers['Content-Type'];
    // Bound only the wait for HEADERS: a stalled non-stream POST (CLI run
    // submission) must settle, while the body stays unlimited because callers
    // stream it. The timer clears once headers arrive.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUTHORIZED_FETCH_HEADER_TIMEOUT_MS);
    const callerSignal = init.signal;
    // The caller's abort stays wired to the fetch signal for the WHOLE life of
    // the response: the finally below runs at HEADERS, and a caller abort after
    // that (the CLI run launcher cancelling a pending reader.read()) must still
    // reach the body. Only the headers timer is cleared there.
    const onCallerAbort = () => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
    try {
      return await streamingFetch(`${this.rootTransport.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
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
    return this.rootTransport.request<RunResponse>('POST', this.withScope(runs), body);
  }

  async getRunStatus(runId: string): Promise<RunStatus> {
    const template = this.endpoints.runStatus;
    const path = template
      ? interpolatePath(template, { id: runId, runId, run_id: runId })
      : `${this.requireRunsEndpoint().replace(/\/+$/, '')}/${runId}`;
    return this.rootTransport.request<RunStatus>('GET', this.withScope(path));
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

    const response = await streamingFetch(`${this.rootTransport.baseUrl}${this.withScope(path)}`, {
      headers: this.rootTransport.headers,
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
    await this.rootTransport.request<unknown>('POST', this.withScope(path), {
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
    await this.rootTransport.request<unknown>('POST', this.withScope(path), {});
  }

  /**
   * Stop a turn the Gate is still running.
   *
   * Aborting the phone's stream is not a cancel: the turn keeps burning a
   * provider on the host, and the Gate only knows to stop it when told which
   * turn — the id streamChat now sends. A gate whose manifest advertises no
   * `chatCancel` has no such route (an older Gate), so the call returns
   * without a request rather than guessing a path. Failures are swallowed: a
   * cancel is a courtesy, and the turn is already lost to the user either way.
   */
  async cancelTurn(turnId: string): Promise<void> {
    const path = this.endpoints.chatCancel;
    if (!path) return;
    try {
      await this.rootTransport.request<unknown>('POST', path, { turnId }, CANCEL_TURN_TIMEOUT_MS);
    } catch {
      // best effort — the local abort already stopped the user's stream
    }
  }

  // ─── The turn journal (design spec §3) ───────────────────────────
  //
  // A Gate with a journal is what makes a detached turn survivable: the turn is
  // the Gate's, not this request's, so a phone that comes back asks what is
  // still running and follows it. A gateway with no such routes is answered
  // once and then never asked again (`turnsUnsupported`), so an older Gate costs
  // one 404 and then behaves exactly as it always did.

  /**
   * True once this Gate answered 404 for `/v1/turns`. Latched for the client's
   * life: the journal does not appear mid-session, and re-reading a route that
   * does not exist on every foreground return is noise the operator can see.
   */
  get turnsUnsupported(): boolean {
    return this.turnsMissing;
  }

  /** The journal's collection route: the manifest's when it declares one. */
  private turnsPath(): string {
    return (this.endpoints.turns ?? '/v1/turns').replace(/\/+$/, '');
  }

  /** True when a refusal named a turn this device cannot read (retention, or a wrong id). */
  private refusedUnknownTurn(error: unknown): boolean {
    const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
    return code === 'unknown_turn';
  }

  /** The HTTP status a refusal carried, when it carried one. */
  private refusalStatus(error: unknown): number | undefined {
    const status = (error as { status?: unknown } | null)?.status;
    return typeof status === 'number' ? status : undefined;
  }

  async listTurns(filter?: TurnListFilter): Promise<TurnMeta[]> {
    if (this.turnsMissing) return [];
    const query = new URLSearchParams();
    if (filter?.sessionId) query.set('sessionId', filter.sessionId);
    if (filter?.status && filter.status !== 'unknown') query.set('status', filter.status);
    if (filter?.limit) query.set('limit', String(filter.limit));
    const suffix = query.toString();
    try {
      const result = await this.rootTransport.request<unknown>(
        'GET',
        `${this.turnsPath()}${suffix ? `?${suffix}` : ''}`,
      );
      return turnsFromListEnvelope(result);
    } catch (error) {
      // A 404 here is a gateway with no journal at all, which is a fact about it
      // rather than a read that failed: latch it, so nothing asks again. Anything
      // else stays retryable, because a flaky host is not a gateway without turns.
      if (this.refusalStatus(error) === 404) {
        this.turnsMissing = true;
        return [];
      }
      throw error;
    }
  }

  async getTurn(turnId: string): Promise<TurnMeta | null> {
    if (this.turnsMissing) return null;
    try {
      const result = await this.rootTransport.request<unknown>(
        'GET',
        `${this.turnsPath()}/${encodeURIComponent(turnId)}`,
      );
      return turnFromMeta(result);
    } catch (error) {
      if (this.refusalStatus(error) === 404) {
        // One turn this device can no longer read (retention) is not a gateway
        // without a journal, so nothing is latched there — only the answer. A
        // bare 404 with no code naming a turn is the route itself missing.
        if (!this.refusedUnknownTurn(error)) this.turnsMissing = true;
        return null;
      }
      throw error;
    }
  }

  /**
   * Replay a turn's journal and follow it live.
   *
   * The very transport the chat stream uses: React Native's global fetch has no
   * readable response body, so a stream read any other way delivers zero events
   * on device while every Node-side test stays green (see streaming-fetch.ts and
   * the comment on `authorizedFetch`). The frames are the chat frames — the
   * Gate journals the payloads it wrote — so this goes through the same reader,
   * and reports each frame's `id:` seq so a drop resumes where it stopped.
   */
  async streamTurnEvents(
    turnId: string,
    options: TurnEventStreamOptions,
  ): Promise<TurnStreamResult> {
    const after = options.after ?? 0;
    if (this.turnsMissing) {
      return { completed: false, text: '', error: null, lastSeq: after };
    }
    const response = await this.authorizedFetch(
      `${this.turnsPath()}/${encodeURIComponent(turnId)}/events?after=${after}`,
      { signal: options.signal },
    );
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      const message = messageFromHttpErrorBody(errorText, response.status);
      if (response.status === 404) {
        // A turn this device cannot read is this read's own failure; a bare 404
        // is the route itself, which latches so nothing asks for it again.
        if (errorCodeFromHttpBody(errorText) !== 'unknown_turn') {
          this.turnsMissing = true;
          throw new Error(message);
        }
        throw new Error(`unknown_turn: ${message}`);
      }
      throw new Error(message);
    }
    return readChatFrames({
      response,
      transport: this.rootTransport,
      signal: options.signal,
      after,
      callbacks: options,
    });
  }

  private setStatus(status: ConnectionStatus, detail = '', info?: { authRejected?: boolean }) {
    this.status = status;
    this.detail = detail;
    this.callbacks.onStatus?.(status, detail, info);
  }
}
