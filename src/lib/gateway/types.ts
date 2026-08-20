// ─── Hermes Gateway API Types ─────────────────────────────────────
// The Hermes API server exposes an OpenAI-compatible HTTP REST API
// with Bearer token auth (default port 8642).

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'pairing';

/**
 * Gateway kinds the portal can identify and connect to.
 * 'custom' = a gateway serving the Open Gateway Manifest with its own kind id.
 */
export type GatewayKind = 'hermes' | 'openclaw' | 'custom' | 'unknown';

export type GatewayProfile = {
  id: string;
  name: string;
  /** Base URL of the gateway, e.g. http://host:8642 */
  url: string;
  /** Kind identified by the portal (hermes/openclaw/custom/unknown) */
  kind?: GatewayKind;
  /** Bearer token for API_SERVER_KEY auth */
  token?: string;
  /** SHA-256 fingerprint observed from discovery; native fetch does not verify it. */
  tlsFingerprint?: string;
  /** True once the user has explicitly trusted the observed fingerprint. */
  tlsFingerprintTrusted?: boolean;
  /** When the observed fingerprint was first trusted. */
  tlsFingerprintFirstSeenAt?: number;
  /** OpenClaw bootstrap/setup token (one-time pairing secret) */
  bootstrapToken?: string;
  /** Session key for scoping long-term memory (optional) */
  sessionKey?: string;
  /** Optional session ID for continuity */
  sessionId?: string;
  /** Target agent on the gateway (OpenClaw chat.send targeting) */
  agentId?: string;
  /** Per-request model override (Hermes-native model selection) */
  model?: string;
  /**
   * Model remembered per chat backend. A Codex model id is meaningless to
   * OpenCode, so one profile-wide override cannot serve both.
   */
  backendModels?: Record<string, string>;
  /** Provider that owns the selected model. */
  providerId?: string;
  createdAt: number;
  discoverySource?: 'local' | 'wide-area' | 'manual' | 'tailscale' | 'relay' | 'deep-link';
  /**
   * Set on a profile materialized from a parent gateway's manifest
   * providers[] entry — see child-sync.ts. Absent on a profile the user
   * added directly.
   */
  parentId?: string;
};

// ─── Health ───────────────────────────────────────────────────────

export type HealthResponse = {
  status: string;
  platform: string;
  version: string;
};

// ─── Capabilities ──────────────────────────────────────────────────

export type GatewayCapabilities = {
  object: string;
  platform: string;
  model: string;
  auth: { type: string; required: boolean };
  runtime: {
    mode: string;
    tool_execution: string;
    split_runtime: boolean;
    description: string;
  };
  features: Record<string, boolean | string>;
  endpoints: Record<string, { method: string; path: string }>;
  /**
   * Every RPC method name this gateway will answer, when it can say so.
   *
   * A Gate reports it from its own dispatch table. Hermes does not report one,
   * so it stays undefined there and the caller falls back to the route map in
   * `rpc-routes.ts`. Undefined means "this gateway cannot tell us" — never
   * "this gateway dispatches nothing".
   */
  rpcMethods?: string[];
};

// ─── Models ────────────────────────────────────────────────────────

export type ModelInfo = {
  id: string;
  object: string;
  created?: number;
  owned_by?: string;
};

export type ModelsResponse = {
  object: string;
  data: ModelInfo[];
};

// ─── Sessions ──────────────────────────────────────────────────────

export type HermesSession = {
  id: string;
  source: string;
  user_id: string | null;
  model: string | null;
  title: string | null;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
  message_count: number;
  tool_call_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  api_call_count: number;
  parent_session_id: string | null;
  last_active: number;
  preview: string | null;
  has_system_prompt: boolean;
  has_model_config: boolean;
};

export type SessionsResponse = {
  object: string;
  data: HermesSession[];
};

export type SessionMessage = {
  id?: string;
  role: string;
  content: string | { type?: string; text?: string }[];
  timestamp?: number;
};

export type SessionMessagesResponse = {
  object: string;
  data: SessionMessage[];
  /** True when older turns exist before this page. Absent on gateways without cursor support. */
  hasMore?: boolean;
  /** Cursor to pass as `before` for the next older page. */
  nextBefore?: string | null;
};

/** One page of history, with whatever paging information the gateway supplied. */
export type SessionMessagePage = {
  messages: SessionMessage[];
  /**
   * Undefined means the gateway did not report paging at all — the caller must
   * fall back to inferring "reached the beginning" from a short page.
   */
  hasMore?: boolean;
  nextBefore?: string | null;
};

// ─── Chat ──────────────────────────────────────────────────────────

/** A single tool invocation surfaced during a response (rendered as a card). */
export type ChatToolCall = {
  name: string;
  status?: 'running' | 'complete' | 'error';
  durationMs?: number;
  detail?: string;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp?: number;
  streaming?: boolean;
  /** True while an offline message waits for the next connected state. */
  queued?: boolean;
  /** Set when the connection drops mid-stream; the bubble may be reconciled later. */
  interrupted?: boolean;
  /** Tool calls attached to this message, when the stream exposes them. */
  toolCalls?: ChatToolCall[];
  command?: {
    input?: string;
    title?: string;
    raw?: string;
    status?: 'running' | 'complete' | 'error';
    ephemeral?: boolean;
    durationMs?: number;
  };
};

export type ChatCompletionResponse = {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

// ─── Runs (async agent tasks) ─────────────────────────────────────

export type RunResponse = {
  run_id: string;
  status: string;
  session_id?: string;
};

export type RunStatus = {
  run_id: string;
  status: string;
  result?: string;
  error?: string;
  events?: RunEvent[];
};

export type RunEvent = {
  type: string;
  data?: Record<string, unknown>;
  timestamp?: number;
};

// ─── Skills / Toolsets ─────────────────────────────────────────────

export type SkillInfo = {
  name: string;
  description: string;
  version?: string;
  tags?: string[];
};

export type ToolsetInfo = {
  name: string;
  tools: string[];
};

// ─── Gateway Hello (kept for compat with UI components) ────────────

export type GatewayHelloOk = {
  type: 'hello-ok';
  protocol: number;
  server: { version?: string; connId?: string };
  auth?: {
    role?: string;
    scopes?: string[];
    deviceToken?: string;
  };
};

// ─── Pairing (Hermes uses simple API key, no pairing) ─────────────

export type PairingDetails = {
  reason?: 'not-paired' | 'role-upgrade' | 'scope-upgrade' | 'metadata-upgrade';
  requestId?: string;
  remediationHint?: string;
  requestedRole?: string;
  requestedScopes?: string[];
  approvedRoles?: string[];
  approvedScopes?: string[];
};

// ─── Command Center Types ──────────────────────────────────────────

export type CommandVerification = 'verified' | 'unverified' | 'experimental' | 'blocked';

export type GatewayFeatureFamily =
  | 'Chat'
  | 'Agent'
  | 'Terminal'
  | 'Sessions'
  | 'Channels'
  | 'Approvals'
  | 'Config'
  | 'Models'
  | 'Plugins'
  | 'Logs'
  | 'Diagnostics'
  | 'Cron'
  | 'Environments'
  | 'Skills'
  | 'Artifacts'
  | 'Tools'
  | 'Devices'
  | 'Nodes'
  | 'Voice'
  | 'Other';

export type GatewayCommandDanger = 'safe' | 'write' | 'destructive';

export type GatewayCommand = {
  id: string;
  label: string;
  group: GatewayFeatureFamily;
  transport: 'rpc' | 'agent' | 'http';
  method?: string;
  httpMethod?: string;
  httpPath?: string;
  params?: Record<string, unknown>;
  agentCommand?: string;
  requiredScope?: string;
  danger: GatewayCommandDanger;
  slash?: string;
  description?: string;
  usage?: string;
  aliases?: string[];
};

export type GatewayMethodAvailability = {
  available: boolean;
  reason?: string;
};

export type GatewayCapabilityGroup = {
  id: string;
  label: string;
  /**
   * `undeclared` means no gateway this app knows how to talk to defines the
   * group at all — distinct from `unsupported`, which means a real capability
   * this gateway does not offer. Undeclared groups are excluded from the
   * ready/total headline; counting them made the figure permanently wrong.
   */
  status: 'available' | 'unavailable' | 'unknown' | 'ready' | 'missing-scope' | 'unsupported' | 'warming' | 'stale' | 'partial' | 'unhealthy' | 'experimental' | 'undeclared';
  availableCount?: number;
  totalCount?: number;
  note?: string;
};

export type GatewayCapabilitySnapshot = {
  checkedAt: number;
  status: 'fresh' | 'stale' | 'warming' | 'partial' | 'offline';
  groups: GatewayCapabilityGroup[];
  methods: Record<string, GatewayMethodAvailability>;
  scopes: string[];
};

export type CommandTranscriptEntry = {
  id: string;
  gatewayId: string;
  sessionKey: string;
  sessionId?: string;
  input: string;
  title: string;
  status: 'running' | 'complete' | 'error' | 'cancelled';
  summary: string;
  raw?: string;
  createdAt: number;
  durationMs?: number;
  ephemeral?: boolean;
};

export type GatewayActionPreview = {
  title: string;
  summary: string;
  risk: 'low' | 'medium' | 'high';
  diff?: { label: string; before: string; after: string }[];
  applyCommand: string;
  affectedTarget?: string;
};
