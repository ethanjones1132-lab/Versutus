import { createChatStreamAcc, interpretChatStreamChunk } from '@/lib/gateway/chat-stream-delta';
import type { PublicBot } from '@/lib/gateway/bots';
import type { CronJob, CronRun, CronTurn } from '@/lib/gateway/cron';
import type { BotGroupRoom, GroupReply, GroupTranscriptEntry } from '@/lib/gateway/groups';
import { isAuthRejection } from '@/lib/gateway/errors';
import { gatewayRootUrl } from '@/lib/gateway/gateway-origin';
import { errorCodeFromHttpBody, messageFromHttpErrorBody } from '@/lib/gateway/http-error-body';
import { HttpTransport } from '@/lib/gateway/http-transport';
import { ConnectionMonitor, hasRecentContact } from '@/lib/gateway/connection-monitor';
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
  private selectedBotId: string | undefined;
  private lastHealthError: string | null = null;
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
    const result = await this.rootTransport.request<{ data?: ModelInfo[] } | ModelInfo[]>(
      'GET',
      this.withScope(path),
    );
    return Array.isArray(result) ? result : result.data ?? [];
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
      /** Which model actually served the turn, once the Gate reports it. */
      onModelReport?: (report: import('@/lib/gateway/run-failures').ModelReport) => void;
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
    if (backendId || this.botId) {
      // A Bot names its own environment (see withScope) — naming the thread's
      // backend too would send the turn to an environment with no Bots.
      if (this.botId) body.bot = this.botId;
      else body.backendId = backendId;
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
      // The body is a JSON envelope. Throwing it verbatim is what put
      // `{"error":{"message":"hermes: 500 …","code":"backend_error"}}` inside an
      // assistant bubble on 2026-08-26 — wire text presented as if the model had
      // said it, in the banner as well. Every other call site in this file
      // already unwraps through the same helper.
      const errorText = await response.text().catch(() => '');
      throw new Error(messageFromHttpErrorBody(errorText, response.status));
    }

    let fullText = '';
    // A failed turn arrives as an error frame inside an HTTP 200 stream, so
    // response.ok above cannot catch it. Ignoring the frame renders an empty
    // assistant bubble with nothing to explain it — the exact silent failure
    // this stream was changed to stop producing. Captured here rather than
    // thrown, because the handler's own catch would swallow a throw.
    let streamError: string | null = null;
    const acc = createChatStreamAcc();
    await this.transport.streamSSE(
      response,
      (data) => {
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
          // Which model actually served the turn. Reported once, after the
          // text, so the caller can say so instead of echoing the pick back.
          if (interpreted.ranModel && options?.onModelReport) {
            options.onModelReport({
              ran: interpreted.ranModel,
              requested: interpreted.requestedModel ?? options?.model,
              provider: interpreted.provider,
            });
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
   * Scope a conversation route.
   *
   * A Bot names its own environment — it is a Hermes profile, and the Gate
   * resolves `bot=` to the environment that actually has Bots. Sending the
   * thread's chat backend alongside it overrode that with a deliberate pin,
   * usually onto Claude Code, and the Gate answered 501 "This backend does
   * not implement bots": tapping an agent bounced straight back to the
   * roster. With no Bot selected the chosen environment is exactly right —
   * that is what configurable chat means.
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
  ): Promise<{ replies: GroupReply[]; roomDisbanded?: boolean }> {
    const path = this.requireEndpoint('botGroups');
    return this.rootTransport.request(
      'POST',
      `${path.replace(/\/+$/, '')}/${encodeURIComponent(groupId)}/messages`,
      input,
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
      this.withScope(`${path}${separator}limit=${limit}`),
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
      : `${sessions!.replace(/\/+$/, '')}/${sessionId}/messages`;
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
    return streamingFetch(`${this.rootTransport.baseUrl}${path}`, { ...init, headers });
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
    return this.rootTransport.request<RunResponse>('POST', this.withExplicitBackend(runs), body);
  }

  /**
   * Scopes a run route to the backend the operator explicitly chose — and only
   * then (same rule as `withBackend` now that `backendId` carries no default).
   * Runs are a capability the Gate resolves like Bots and jobs: naming the
   * default environment turned every run into a deliberate pin on the one that
   * refuses runs (501 runs_unsupported). An explicit pick survives; nothing
   * selected leaves the route unpinned so the Gate resolves the runnable
   * environment by capability.
   */
  private withExplicitBackend(path: string): string {
    const backendId = this.selectedBackendId;
    if (!backendId) return path;
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}backendId=${encodeURIComponent(backendId)}`;
  }

  async getRunStatus(runId: string): Promise<RunStatus> {
    const template = this.endpoints.runStatus;
    const path = template
      ? interpolatePath(template, { id: runId, runId, run_id: runId })
      : `${this.requireRunsEndpoint().replace(/\/+$/, '')}/${runId}`;
    return this.rootTransport.request<RunStatus>('GET', this.withExplicitBackend(path));
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

    const response = await streamingFetch(`${this.rootTransport.baseUrl}${this.withExplicitBackend(path)}`, {
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
    await this.rootTransport.request<unknown>('POST', this.withExplicitBackend(path), {
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
    await this.rootTransport.request<unknown>('POST', this.withExplicitBackend(path), {});
  }

  private setStatus(status: ConnectionStatus, detail = '') {
    this.status = status;
    this.detail = detail;
    this.callbacks.onStatus?.(status, detail);
  }
}
