// ─── Gateway adapter registry ─────────────────────────────────────
// Maps an identified GatewayKind to a concrete client. The provider
// talks to a single PortalClient surface; each adapter speaks its own
// dialect underneath. See docs/portal-architecture.md §6.

import { HermesGatewayClient, type GatewayClientCallbacks } from '@/lib/gateway/client';
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
    options?: { model?: string; sessionId?: string; signal?: AbortSignal },
  ): Promise<string>;
  getModels(): Promise<ModelInfo[]>;
  getCapabilities(): Promise<GatewayCapabilities>;
  getSessions(limit?: number): Promise<HermesSession[]>;
  createSession?(title?: string): Promise<HermesSession>;
  deleteSession?(sessionId: string): Promise<void>;
  getSessionMessages(sessionId: string, limit?: number): Promise<SessionMessage[]>;
  stopRun(runId: string): Promise<void>;
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
