export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'pairing';

export type GatewayProfile = {
  id: string;
  name: string;
  url: string;
  token?: string;
  bootstrapToken?: string;
  tlsFingerprint?: string;
  sessionKey: string;
  agentId: string;
  createdAt: number;
  discoverySource?: 'local' | 'wide-area' | 'manual' | 'tailscale';
};

export type StoredDeviceIdentity = {
  version: 1;
  deviceId: string;
  publicKeyB64Url: string;
  privateKeyB64Url: string;
  createdAtMs: number;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp?: number;
  streaming?: boolean;
  command?: {
    input?: string;
    title?: string;
    raw?: string;
    status?: 'running' | 'complete' | 'error';
    ephemeral?: boolean;
    durationMs?: number;
  };
};

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

export type PairingDetails = {
  reason?: 'not-paired' | 'role-upgrade' | 'scope-upgrade' | 'metadata-upgrade';
  requestId?: string;
  remediationHint?: string;
  requestedRole?: string;
  requestedScopes?: string[];
  approvedRoles?: string[];
  approvedScopes?: string[];
};

export type GatewayFrame =
  | { type: 'event'; event: string; payload?: unknown; seq?: number }
  | {
      type: 'res';
      id: string;
      ok: boolean;
      payload?: unknown;
      error?: { code?: string; message?: string; details?: { code?: string } & Record<string, unknown> };
    };

export type ChatEventPayload = {
  runId?: string;
  sessionKey?: string;
  state?: 'delta' | 'final' | 'error' | 'started';
  deltaText?: string;
  errorMessage?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
    timestamp?: number;
  };
};

// --- Command Center Types (Phase 1 foundation) ---

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

export type GatewayConfirmationSpec = {
  title: string;
  risk: 'low' | 'medium' | 'high';
  requiresScope?: string;
};

export type GatewayCommand = {
  id: string;
  slash: string;
  family: GatewayFeatureFamily;
  method?: string;
  params?: Record<string, unknown>;
  requiredScope?: string;
  danger: 'safe' | 'write' | 'destructive';
  verification: CommandVerification;
  supportsPreview: boolean;
  confirmation?: GatewayConfirmationSpec;
  formatter?: (result: unknown) => { text: string; title?: string; raw?: string };
  label?: string;
  description?: string;
  aliases?: string[];
  transport?: 'rpc' | 'agent';
  agentCommand?: string;
};

export type GatewayMethodAvailability = {
  available: boolean;
  reason?: string;
};

export type GatewayCapabilityGroup = {
  id: string;
  label: string;
  status: 'available' | 'unavailable' | 'unknown' | 'ready' | 'missing-scope' | 'unsupported' | 'warming' | 'stale' | 'unhealthy' | 'experimental';
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
  ephemeral?: boolean; // true for local-only until gateway persistence
};

export type GatewayActionPreview = {
  title: string;
  summary: string;
  risk: 'low' | 'medium' | 'high';
  diff?: Array<{ label: string; before: string; after: string }>;
  applyCommand: string;
  affectedTarget?: string;
};

// Note: Import GatewayCapabilityGroup and Slash* directly from their modules to avoid cycles.
