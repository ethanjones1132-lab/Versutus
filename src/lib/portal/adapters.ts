// ─── Gateway adapter registry ─────────────────────────────────────
// Maps an identified GatewayKind to a concrete client. The provider
// talks to a single PortalClient surface; each adapter speaks its own
// dialect underneath. See docs/portal-architecture.md §6.

import { HermesGatewayClient, type GatewayClientCallbacks } from '@/lib/gateway/client';
import type { PublicBot } from '@/lib/gateway/bots';
import type { BotGroupRoom, GroupReply, GroupTranscriptEntry } from '@/lib/gateway/groups';
import { ManifestClient } from '@/lib/gateway/manifest-client';
import { OpenClawAdapterClient } from '@/lib/portal/openclaw-adapter';
import type { GatewayIdentity } from '@/lib/portal/identify';
import type {
  ConnectionStatus,
  GatewayCapabilities,
  GatewayKind,
  GatewayProfile,
  HealthResponse,
  HermesSession,
  ModelInfo,
  SessionMessage,
  SessionMessagePage,
} from '@/lib/gateway/types';

/** The unified client surface the provider uses, regardless of kind. */
export interface PortalClient {
  connect(): Promise<void> | void;
  disconnect(): void;
  readonly connectionStatus: ConnectionStatus;
  readonly statusDetail: string;
  updateProfile(profile: GatewayProfile): void;
  get sessionId(): string | undefined;
  setSessionId(id: string | undefined): void;
  healthCheck(timeoutMs?: number): Promise<HealthResponse | null>;
  rpcRequest<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  streamChat(
    messages: { role: string; content: string }[],
    onDelta: (text: string) => void,
    options?: {
      model?: string;
      /** Owning provider, when known — disambiguates a model id declared by more than one. */
      providerId?: string;
      sessionId?: string;
      signal?: AbortSignal;
      /** OpenAI-style tool_calls deltas when the gateway emits them. */
      onToolCall?: (tool: import('@/lib/gateway/types').ChatToolCall) => void;
      /** Reasoning/thinking deltas streamed alongside content, when the model exposes them. */
      onReasoning?: (text: string) => void;
      /**
       * Which model actually served the turn, once the gateway says so.
       * Backends substitute — reporting only the request would keep repeating
       * the operator's own choice back at them.
       */
      onModelReport?: (report: import('@/lib/gateway/run-failures').ModelReport) => void;
    },
  ): Promise<string>;
  getModels(): Promise<ModelInfo[]>;
  getCapabilities(): Promise<GatewayCapabilities>;
  /** Whether the manifest explicitly offers session management. */
  readonly canManageSessions?: boolean;
  getSessions(limit?: number): Promise<HermesSession[]>;
  /**
   * One Bot's own catalogue, with the Bot named in the query instead of taken
   * from the client's stored scope — the per-Bot spend read. Optional: an
   * adapter that cannot scope a session list by Bot omits it, and the per-Bot
   * section then degrades to the gateway total alone.
   */
  listBotSessionCatalogue?(botId: string, limit?: number): Promise<HermesSession[]>;
  /**
   * `model` pins the session at creation. It cannot be applied later — a
   * Hermes session's model is immutable once opened — so a caller that has a
   * model must pass it here or the thread runs on the host default for good.
   */
  createSession?(title?: string, model?: string): Promise<HermesSession>;
  /** Hermes profile selector on a Gate. Omitted on adapters that are not the Gate. */
  listBots?(): Promise<PublicBot[]>;
  createBot?(input: {
    name: string;
    soul?: string;
    inheritKeys?: boolean;
    description?: string;
    modelId?: string;
    providerId?: string;
  }): Promise<PublicBot>;
  /** Edit an existing Bot's soul, description or model pin; null clears a pin. Gate adapters only. */
  updateBot?(input: {
    id: string;
    soul?: string;
    description?: string;
    modelId?: string | null;
    providerId?: string | null;
  }): Promise<PublicBot>;
  /**
   * Cron transparency, Gate adapters only. Omitted on adapters that cannot
   * join a job to the runs it wrote — the surface then does not render at all,
   * rather than showing an empty list that looks like "no scheduled work".
   */
  listCronJobs?(): Promise<import('@/lib/gateway/cron').CronJob[]>;
  cronRuns?(jobId: string): Promise<import('@/lib/gateway/cron').CronRun[]>;
  cronTranscript?(runId: string, limit?: number): Promise<import('@/lib/gateway/cron').CronTurn[]>;
  listJobs?(): Promise<{ id: string; name?: string; paused?: boolean }[]>;
  createJob?(input: { name: string; prompt: string; schedule: string }): Promise<{ id: string; name?: string }>;
  runJob?(jobId: string): Promise<void>;
  setJobPaused?(jobId: string, paused: boolean): Promise<void>;
  removeJob?(jobId: string): Promise<void>;
  /** Gate-owned group rooms. Omitted when the manifest advertises no botGroups endpoint. */
  listGroups?(): Promise<BotGroupRoom[]>;
  createGroup?(input: { name: string; memberIds: string[] }): Promise<BotGroupRoom>;
  sendGroupMessage?(
    groupId: string,
    input: { text: string; mentionedIds?: string[] },
  ): Promise<{ replies: GroupReply[]; roomDisbanded?: boolean }>;
  /** Stored room transcript; omitted when the gate has no rooms endpoint. */
  groupHistory?(groupId: string): Promise<GroupTranscriptEntry[]>;
  renameGroup?(groupId: string, name: string): Promise<BotGroupRoom>;
  leaveGroup?(groupId: string, memberId: string): Promise<BotGroupRoom>;
  deleteGroup?(groupId: string): Promise<{ ok: boolean }>;
  addGroupMembers?(groupId: string, memberIds: string[]): Promise<BotGroupRoom>;
  handoffMention?(input: { fromId: string; toId: string; text: string }): Promise<unknown>;
  setBotId?(id: string | undefined): void;
  setBackendId?(id: string | undefined): void;
  readonly botId?: string;
  deleteSession?(sessionId: string): Promise<void>;
  getSessionMessages(sessionId: string, limit?: number): Promise<SessionMessage[]>;
  /**
   * One page of history ending just before `before`. Optional: adapters for
   * gateways with no cursor support omit it, and callers fall back to
   * re-fetching with a larger limit.
   */
  getSessionMessagePage?(
    sessionId: string,
    limit?: number,
    before?: string,
  ): Promise<SessionMessagePage>;
  stopRun(runId: string): Promise<void>;
  /**
   * Authenticated fetch against the gateway origin for routes that are not RPC
   * and not chat — CLI run submission and its SSE event stream. Keeps transport
   * details (base URL, bearer, session key) inside the adapter.
   */
  authorizedFetch?(path: string, init?: RequestInit): Promise<Response>;
  /** Pause automatic reconnect (e.g. app backgrounded). */
  suspendReconnect(): void;
  /** Resume automatic reconnect; attempts immediately if not connected. */
  resumeReconnect(): void;
  /** Agentic runs with approval gates — Hermes adapters only. */
  startRun?(
    prompt: string,
    options?: { sessionId?: string; model?: string },
  ): Promise<{ run_id: string; status: string; session_id?: string }>;
  getRunStatus?(runId: string): Promise<{ run_id: string; status: string; result?: string; error?: string }>;
  streamRunEvents?(
    runId: string,
    onEvent: (event: { type: string; data?: Record<string, unknown>; timestamp?: number }) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  resolveApproval?(runId: string, approved: boolean, feedback?: string): Promise<void>;
}

/** Callbacks accepted by every adapter (params kept loose on purpose). */
export type PortalClientCallbacks = {
  onStatus?: (status: ConnectionStatus, detail?: string) => void;
  onHello?: (hello: unknown) => void;
  onPairingRequired?: (details: unknown) => void;
  onChatEvent?: (payload: unknown) => void;
  onError?: (message: string) => void;
  onHealthCheck?: (healthy: boolean, info?: HealthResponse) => void;
  onCapabilities?: (capabilities: GatewayCapabilities) => void;
};

export type AdapterDefinition = {
  kind: GatewayKind;
  label: string;
  /** Whether this adapter speaks the Hermes HTTP dialect. */
  hermesSurface: boolean;
};

export const ADAPTERS: AdapterDefinition[] = [
  { kind: 'hermes', label: 'Hermes', hermesSurface: true },
  { kind: 'openclaw', label: 'OpenClaw', hermesSurface: false },
  { kind: 'custom', label: 'Custom (manifest)', hermesSurface: false },
  { kind: 'unknown', label: 'Generic HTTP', hermesSurface: true },
];

export function adapterForKind(kind: GatewayKind): AdapterDefinition {
  return ADAPTERS.find((adapter) => adapter.kind === kind) ?? ADAPTERS[3];
}

/**
 * Create the client for an identified gateway kind.
 * - hermes / unknown → HermesGatewayClient (HTTP + SSE)
 * - openclaw → OpenClawAdapterClient (WS v4 with a Hermes-shaped surface)
 * - custom → ManifestClient when an identity with usable manifest routes is
 *   supplied (requires endpoints.health so connect can probe); falls back to
 *   the Hermes-shaped HTTP adapter when the manifest has no usable routes.
 */
export function createClientForKind(
  kind: GatewayKind,
  profile: GatewayProfile,
  callbacks: PortalClientCallbacks = {},
  identity?: GatewayIdentity,
): PortalClient {
  switch (kind) {
    case 'openclaw':
      return new OpenClawAdapterClient(profile, callbacks);
    case 'custom':
      if (identity?.manifest?.endpoints?.health) {
        return new ManifestClient(profile, identity, callbacks);
      }
      return new HermesGatewayClient(profile, callbacks as GatewayClientCallbacks);
    case 'hermes':
    case 'unknown':
    default:
      return new HermesGatewayClient(profile, callbacks as GatewayClientCallbacks);
  }
}
