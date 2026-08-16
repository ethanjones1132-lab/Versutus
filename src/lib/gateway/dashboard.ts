import type { ConnectionStatus, GatewayHelloOk } from '@/lib/gateway/types';
import type { GatewayCapabilityInstance } from '@/lib/portal/manifest';

export type GatewayReachabilityState =
  | 'connected'
  | 'reachable'
  | 'unreachable'
  | 'checking'
  | 'unknown';

export type GatewayReachability = {
  gatewayId: string;
  url: string;
  state: GatewayReachabilityState;
  latencyMs?: number;
  checkedAt?: number;
  error?: string;
};

export type GatewayCommandDanger = 'safe' | 'write' | 'destructive';

export type GatewayCommand = {
  id: string;
  label: string;
  group:
    | 'Gateway'
    | 'Sessions'
    | 'Channels'
    | 'Agent'
    | 'Diagnostics'
    | 'Models'
    | 'Config'
    | 'Plugins'
    | 'Approvals'
    | 'Logs'
    | 'Memory'
    | 'System'
    | 'Devices'
    | 'Tools'
    | 'Skills'
    | 'Voice';
  transport: 'rpc' | 'agent';
  method?: string;
  params?: Record<string, unknown>;
  agentCommand?: string;
  requiredScope?: string;
  danger: GatewayCommandDanger;
  slash?: string;
  description?: string;
  usage?: string;
  aliases?: string[];
};

export type GatewayCapabilityStatus = 'available' | 'unavailable' | 'unknown';

export type GatewayCapabilityGroup = {
  id: string;
  label: string;
  status: GatewayCapabilityStatus;
  availableCount: number;
  totalCount: number;
  note?: string;
};

export const GATEWAY_COMMANDS: GatewayCommand[] = [
  {
    id: 'health',
    label: 'Health',
    group: 'Gateway',
    transport: 'rpc',
    method: 'health',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/health',
    description: 'Gateway health check',
  },
  {
    id: 'status',
    label: 'Status',
    group: 'Gateway',
    transport: 'rpc',
    method: 'status',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/status',
    description: 'Gateway status snapshot',
  },
  {
    id: 'sessions',
    label: 'Sessions',
    group: 'Sessions',
    transport: 'rpc',
    method: 'sessions.list',
    params: { limit: 10 },
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/sessions',
    description: 'Recent sessions',
  },
  {
    id: 'channels',
    label: 'Channels',
    group: 'Channels',
    transport: 'rpc',
    method: 'channels.status',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/channels',
    description: 'Connected channel state',
  },
  {
    id: 'channel-start',
    label: 'Start channel',
    group: 'Channels',
    transport: 'rpc',
    method: 'channel.start',
    params: {},
    requiredScope: 'operator.write',
    danger: 'write',
    slash: '/channel start',
    description: 'Start a channel (e.g. Discord, Telegram)',
  },
  {
    id: 'channel-stop',
    label: 'Stop channel',
    group: 'Channels',
    transport: 'rpc',
    method: 'channel.stop',
    params: {},
    requiredScope: 'operator.write',
    danger: 'write',
    slash: '/channel stop',
    description: 'Stop a channel',
  },
  {
    id: 'channel-logout',
    label: 'Logout channel',
    group: 'Channels',
    transport: 'rpc',
    method: 'channel.logout',
    params: {},
    requiredScope: 'operator.write',
    danger: 'write',
    slash: '/channel logout',
    description: 'Logout a channel account',
  },
  {
    id: 'usage',
    label: 'Usage',
    group: 'Diagnostics',
    transport: 'rpc',
    method: 'usage.status',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/usage',
    description: 'Token and request usage',
  },
  {
    id: 'cost',
    label: 'Cost',
    group: 'Diagnostics',
    transport: 'rpc',
    method: 'usage.cost',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/cost',
    description: 'Cost summary',
  },
  {
    id: 'stability',
    label: 'Stability',
    group: 'Diagnostics',
    transport: 'rpc',
    method: 'diagnostics.stability',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/stability',
    description: 'Gateway stability diagnostics',
  },
  {
    id: 'diagnostics',
    label: 'Diagnostics',
    group: 'Diagnostics',
    transport: 'rpc',
    method: 'diagnostics.full',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/diagnostics',
    description: 'Full human-readable diagnostics summary',
  },
  {
    id: 'logs-error',
    label: 'Error logs',
    group: 'Logs',
    transport: 'rpc',
    method: 'logs.tail',
    params: { level: 'error', limit: 20 },
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/logs error',
    description: 'Tail error logs with pagination',
  },
  {
    id: 'logs-warn',
    label: 'Warn logs',
    group: 'Logs',
    transport: 'rpc',
    method: 'logs.tail',
    params: { level: 'warn', limit: 20 },
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/logs warn',
    description: 'Tail warn logs',
  },
  {
    id: 'logs',
    label: 'Logs',
    group: 'Logs',
    transport: 'rpc',
    method: 'logs.tail',
    params: { limit: 40, maxBytes: 16000 },
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/logs',
    description: 'Tail gateway logs',
  },
  {
    id: 'models',
    label: 'Models',
    group: 'Models',
    transport: 'rpc',
    method: 'models.list',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/models',
    description: 'Available model catalog',
  },
  {
    id: 'model-auth',
    label: 'Model auth',
    group: 'Models',
    transport: 'rpc',
    method: 'models.authStatus',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/model auth',
    description: 'Model provider auth state',
  },
  {
    id: 'config',
    label: 'Config',
    group: 'Config',
    transport: 'rpc',
    method: 'config.get',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/config',
    description: 'Read gateway config',
  },
  {
    id: 'config-schema',
    label: 'Config schema',
    group: 'Config',
    transport: 'rpc',
    method: 'config.schema',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/config schema',
    description: 'Read config schema',
  },
  {
    id: 'config-patch',
    label: 'Write config',
    group: 'Config',
    transport: 'rpc',
    method: 'config.patch',
    params: {},
    requiredScope: 'operator.write',
    danger: 'write',
    slash: '/config patch',
    description: 'Write one or more config keys (JSON)',
    usage: '/config patch {"key":"value"}',
  },
  {
    id: 'plugins',
    label: 'Plugins',
    group: 'Plugins',
    transport: 'rpc',
    method: 'plugins.uiDescriptors',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/plugins',
    description: 'Installed plugin UI descriptors',
  },
  {
    id: 'approvals',
    label: 'Approvals',
    group: 'Approvals',
    transport: 'rpc',
    method: 'exec.approvals.get',
    params: {},
    requiredScope: 'operator.admin',
    danger: 'safe',
    slash: '/approvals',
    description: 'Execution approval policy',
  },
  {
    id: 'approvals-pending',
    label: 'Pending approvals',
    group: 'Approvals',
    transport: 'rpc',
    method: 'approvals.pending',
    params: {},
    requiredScope: 'operator.admin',
    danger: 'safe',
    slash: '/approvals pending',
    description: 'List pending approvals',
  },
  {
    id: 'approval-approve',
    label: 'Approve',
    group: 'Approvals',
    transport: 'rpc',
    method: 'approval.approve',
    params: {},
    requiredScope: 'operator.admin',
    danger: 'write',
    slash: '/approval approve',
    description: 'Approve a pending request (requires confirmation)',
  },
  {
    id: 'approval-deny',
    label: 'Deny',
    group: 'Approvals',
    transport: 'rpc',
    method: 'approval.deny',
    params: {},
    requiredScope: 'operator.admin',
    danger: 'write',
    slash: '/approval deny',
    description: 'Deny a pending request (requires confirmation)',
  },
  {
    id: 'device',
    label: 'Device',
    group: 'Devices',
    transport: 'rpc',
    method: 'device.info',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/device',
    description: 'Local device identity, roles, scopes, token state',
  },
  {
    id: 'device-revoke',
    label: 'Revoke device',
    group: 'Devices',
    transport: 'rpc',
    method: 'device.revoke',
    params: {},
    requiredScope: 'operator.admin',
    danger: 'destructive',
    slash: '/device revoke',
    description: 'Revoke device token (high risk)',
  },
  {
    id: 'device-repair',
    label: 'Repair device token',
    group: 'Devices',
    transport: 'rpc',
    method: 'device.repair',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/device repair',
    description: 'Attempt token repair flow (reconnect with stored token)',
  },
  {
    id: 'memory',
    label: 'Memory',
    group: 'Memory',
    transport: 'rpc',
    method: 'doctor.memory.status',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/memory',
    description: 'Memory doctor status',
  },
  {
    id: 'skills-status',
    label: 'Skills status',
    group: 'Skills',
    transport: 'rpc',
    method: 'skills.status',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/skills status',
    description: 'Skills runtime status',
  },
  {
    id: 'environments',
    label: 'Environments',
    group: 'System',
    transport: 'rpc',
    method: 'environments.status',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/env',
    aliases: ['/environments'],
    description: 'Environment status',
  },
  {
    id: 'cron',
    label: 'Cron',
    group: 'System',
    transport: 'rpc',
    method: 'cron.status',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/cron',
    description: 'Cron runner status',
  },
  {
    id: 'agents',
    label: 'Agents',
    group: 'Agent',
    transport: 'rpc',
    method: 'agents.list',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/agents',
    description: 'List agents and their state',
  },
  {
    id: 'tools',
    label: 'Tools',
    group: 'Tools',
    transport: 'rpc',
    method: 'tools.list',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/tools',
    description: 'Available tools / effective profile',
  },
  {
    id: 'plugins',
    label: 'Plugins',
    group: 'Plugins',
    transport: 'rpc',
    method: 'plugins.list',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/plugins',
    description: 'Installed plugins',
  },
  {
    id: 'cron-list',
    label: 'Cron list',
    group: 'System',
    transport: 'rpc',
    method: 'cron.list',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/cron list',
    description: 'Cron jobs list',
  },
  {
    id: 'env-list',
    label: 'Environments',
    group: 'System',
    transport: 'rpc',
    method: 'environments.list',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/env list',
    description: 'Environment list',
  },
  {
    id: 'skills',
    label: 'Skills',
    group: 'Skills',
    transport: 'rpc',
    method: 'skills.list',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/skills',
    description: 'Available / installed skills',
  },
  {
    id: 'artifacts',
    label: 'Artifacts',
    group: 'System',
    transport: 'rpc',
    method: 'artifacts.list',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/artifacts',
    description: 'Artifacts list',
  },
  {
    id: 'talk-catalog',
    label: 'Talk catalog',
    group: 'Voice',
    transport: 'rpc',
    method: 'talk.catalog',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/talk catalog',
    description: 'Voice/Talk catalog (read-first)',
  },
  {
    id: 'voicewake',
    label: 'VoiceWake',
    group: 'Voice',
    transport: 'rpc',
    method: 'voicewake.status',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/voicewake',
    description: 'VoiceWake routing and status',
  },
  {
    id: 'agent-status',
    label: '/status',
    group: 'Agent',
    transport: 'agent',
    agentCommand: '/status',
    requiredScope: 'operator.write',
    danger: 'safe',
    slash: '/agent status',
    aliases: ['/astatus'],
    description: 'Ask the active agent for status',
  },
  {
    id: 'agent-stop',
    label: '/stop',
    group: 'Agent',
    transport: 'agent',
    agentCommand: '/stop',
    requiredScope: 'operator.write',
    danger: 'write',
    slash: '/stop',
    aliases: ['/agent stop'],
    description: 'Stop the active agent run',
  },
  {
    id: 'run-task',
    label: 'Run task',
    group: 'Agent',
    transport: 'rpc',
    method: 'runs.create',
    params: {},
    danger: 'safe',
    slash: '/run',
    description: 'Run an agentic task with approval gates',
    usage: '/run <prompt>',
  },
  {
    id: 'session-current',
    label: 'Current session',
    group: 'Sessions',
    transport: 'rpc',
    method: 'sessions.current',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/session current',
    description: 'Show current session info',
  },
  {
    id: 'session-list',
    label: 'List sessions',
    group: 'Sessions',
    transport: 'rpc',
    method: 'sessions.list',
    params: { limit: 10 },
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/session list',
    description: 'List recent sessions',
  },
  {
    id: 'session-get',
    label: 'Get session',
    group: 'Sessions',
    transport: 'rpc',
    method: 'session.get',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/session get',
    description: 'Get session details by id',
  },
  {
    id: 'session-messages',
    label: 'Session messages',
    group: 'Sessions',
    transport: 'rpc',
    method: 'session.messages',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/session messages',
    description: 'Get messages for session',
  },
  {
    id: 'session-usage',
    label: 'Session usage',
    group: 'Sessions',
    transport: 'rpc',
    method: 'session.usage',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/session usage',
    description: 'Usage for session',
  },
  {
    id: 'session-abort',
    label: 'Abort session',
    group: 'Sessions',
    transport: 'rpc',
    method: 'session.abort',
    params: {},
    requiredScope: 'operator.write',
    danger: 'write',
    slash: '/session abort',
    description: 'Abort a session (destructive)',
  },
  {
    id: 'session-compact',
    label: 'Compact session',
    group: 'Sessions',
    transport: 'rpc',
    method: 'session.compact',
    params: {},
    requiredScope: 'operator.write',
    danger: 'write',
    slash: '/session compact',
    description: 'Compact session history',
  },
  {
    id: 'session-restore',
    label: 'Restore session',
    group: 'Sessions',
    transport: 'rpc',
    method: 'session.restore',
    params: {},
    requiredScope: 'operator.write',
    danger: 'write',
    slash: '/session restore',
    description: 'Restore a session',
  },
];

const CAPABILITY_DEFS = [
  { id: 'chat', label: 'Chat', requiredScopes: ['operator.write'], count: 1 },
  { id: 'agent', label: 'Agent', requiredScopes: ['operator.write'], count: 2 },
  { id: 'terminal', label: 'Terminal', requiredScopes: ['operator.write'], count: 1 },
  { id: 'sessions', label: 'Sessions', requiredScopes: ['operator.read'], count: 1 },
  { id: 'channels', label: 'Channels', requiredScopes: ['operator.read'], count: 2 },
  { id: 'approvals', label: 'Approvals', requiredScopes: ['approvals'], count: 1 },
  { id: 'config', label: 'Config', requiredScopes: ['admin'], count: 2 },
  { id: 'plugins', label: 'Plugins', requiredScopes: ['operator.read'], count: 2 },
  { id: 'logs', label: 'Logs', requiredScopes: ['operator.read'], count: 1 },
  { id: 'voice', label: 'Voice/Talk', requiredScopes: ['operator.write'], count: 2 },
  { id: 'diagnostics', label: 'Diagnostics', requiredScopes: ['operator.read'], count: 3 },
];

/**
 * Safe RPC quick set for the Tools tab. Prefer commands with a Hermes route
 * map entry — host-only/guidance methods (channels, config, …) stay out of
 * the default grid so the tab does not look broken.
 */
export function homeQuickCommands(): GatewayCommand[] {
  const preferred = ['health', 'status', 'sessions', 'models', 'skills', 'tools'];
  const seen = new Set<string>();
  return GATEWAY_COMMANDS.filter((command) => {
    if (!preferred.includes(command.id) || seen.has(command.id)) return false;
    seen.add(command.id);
    return true;
  });
}

export function rpcCommands(): GatewayCommand[] {
  return GATEWAY_COMMANDS.filter((command) => command.transport === 'rpc');
}

export function agentCommands(): GatewayCommand[] {
  return GATEWAY_COMMANDS.filter((command) => command.transport === 'agent');
}

/**
 * Filter a command list to what the live capability snapshot says is
 * available. When availability is unknown (empty methods map), keep the
 * original list so OpenClaw/offline tooling still shows something.
 */
export function filterExecutableCommands(
  commands: GatewayCommand[],
  methods: Record<string, { available: boolean; reason?: string }> = {},
): GatewayCommand[] {
  const keys = Object.keys(methods);
  if (keys.length === 0) return commands;
  return commands.filter((command) => methods[command.id]?.available !== false);
}

export function buildCapabilityGroups(
  status: ConnectionStatus,
  hello: GatewayHelloOk | null,
): GatewayCapabilityGroup[] {
  const scopes = hello?.auth?.scopes ?? [];
  const connected = status === 'connected';

  return CAPABILITY_DEFS.map((definition) => {
    if (!connected) {
      return {
        id: definition.id,
        label: definition.label,
        status: 'unavailable',
        availableCount: 0,
        totalCount: definition.count,
        note: 'Gateway offline',
      };
    }

    if (scopes.length === 0) {
      return {
        id: definition.id,
        label: definition.label,
        status: 'unknown',
        availableCount: 0,
        totalCount: definition.count,
        note: 'Scope snapshot pending',
      };
    }

    const allowed = definition.requiredScopes.some((scope) => hasScope(scopes, scope));
    return {
      id: definition.id,
      label: definition.label,
      status: allowed ? 'available' : 'unavailable',
      availableCount: allowed ? definition.count : 0,
      totalCount: definition.count,
      note: allowed ? undefined : 'Scope unavailable',
    };
  });
}

// ─── Live capability snapshot ──────────────────────────────────────
// Groups resolve from what the gateway advertises in GET /v1/capabilities:
// a `features` flag or an `endpoints` key. Verified against hermes-agent
// 0.18.0 — see __tests__/capability-snapshot-test.ts for the payload.
//
// Scopes are deliberately not consulted: the Hermes hello carries no
// `auth.scopes`, so treating their absence as "warming" pinned most of the
// dashboard to a permanent pending state.

type CapabilityGroupDef = {
  id: string;
  label: string;
  /** Any of these `features` flags being true makes the group ready. */
  features?: string[];
  /** Any of these `endpoints` keys being present makes the group ready. */
  endpoints?: string[];
  /** Registry command groups counted toward this capability. */
  commandGroups?: GatewayCommand['group'][];
};

const CAPABILITY_GROUP_DEFS: CapabilityGroupDef[] = [
  // Hermes uses chat_completions / run_submission / …; Gate manifests use
  // short keys (chat, runs, sessions). Both alias sets must match or Gate
  // chat falsely shows "unsupported" while streamChat works.
  {
    id: 'chat',
    label: 'Chat',
    features: ['chat_completions', 'chat'],
    endpoints: ['chat_completions', 'chat'],
    commandGroups: ['Agent'],
  },
  {
    id: 'agent',
    label: 'Agent',
    features: ['run_submission', 'runs'],
    endpoints: ['runs'],
    commandGroups: ['Agent'],
  },
  {
    id: 'sessions',
    label: 'Sessions',
    features: ['session_resources', 'sessions'],
    endpoints: ['sessions'],
    commandGroups: ['Sessions'],
  },
  {
    id: 'approvals',
    label: 'Approvals',
    features: ['run_approval_response', 'approvals'],
    endpoints: ['run_approval', 'approvals'],
    commandGroups: ['Approvals'],
  },
  { id: 'models', label: 'Models', features: ['models'], endpoints: ['models'], commandGroups: ['Models'] },
  {
    id: 'skills',
    label: 'Skills',
    features: ['skills_api', 'skills'],
    endpoints: ['skills'],
    commandGroups: ['Skills'],
  },
  { id: 'tools', label: 'Tools', features: ['tools'], endpoints: ['toolsets', 'tools'], commandGroups: ['Tools'] },
  {
    id: 'diagnostics',
    label: 'Diagnostics',
    endpoints: ['health_detailed'],
    commandGroups: ['Gateway', 'Diagnostics'],
  },
  { id: 'terminal', label: 'Terminal', features: ['terminal'], endpoints: ['terminal'] },
  { id: 'config', label: 'Config', features: ['admin_config_rw'], commandGroups: ['Config'] },
  { id: 'cron', label: 'Cron', features: ['jobs_admin'] },
  { id: 'memory', label: 'Memory', features: ['memory_write_api'], commandGroups: ['Memory'] },
  { id: 'voice', label: 'Voice/Talk', features: ['audio_api', 'realtime_voice'], commandGroups: ['Voice'] },
  { id: 'channels', label: 'Channels', commandGroups: ['Channels'] },
  { id: 'plugins', label: 'Plugins', commandGroups: ['Plugins'] },
  { id: 'logs', label: 'Logs', commandGroups: ['Logs'] },
  { id: 'devices', label: 'Devices', commandGroups: ['Devices'] },
  // A Gate serves both of these; without keys to match on, groupIsAdvertised
  // could never return true and both tiles read "Not offered" permanently.
  {
    id: 'providers',
    label: 'Providers',
    features: ['providers'],
    endpoints: ['providers'],
    commandGroups: ['Models'],
  },
  {
    id: 'environments',
    label: 'Environments',
    features: ['environments'],
    endpoints: ['environments'],
  },
  { id: 'artifacts', label: 'Artifacts' },
  { id: 'nodes', label: 'Nodes' },
];

function groupIsAdvertised(
  definition: CapabilityGroupDef,
  capabilities: import('@/lib/gateway/types').GatewayCapabilities,
): boolean {
  const features = (capabilities.features ?? {}) as Record<string, unknown>;
  if (definition.features?.some((flag) => features[flag] === true)) return true;

  const endpoints = (capabilities.endpoints ?? {}) as Record<string, unknown>;
  return definition.endpoints?.some((key) => endpoints[key] != null) ?? false;
}

export function buildCapabilitySnapshot(
  status: ConnectionStatus,
  hello: GatewayHelloOk | null,
  commands: GatewayCommand[] = GATEWAY_COMMANDS,
  lastProbeAt: number = Date.now(),
  capabilities: import('@/lib/gateway/types').GatewayCapabilities | null = null,
  capabilityInstances: GatewayCapabilityInstance[] = [],
): import('@/lib/gateway/types').GatewayCapabilitySnapshot {
  const scopes = hello?.auth?.scopes ?? [];
  const connected = status === 'connected';
  const isStale = Date.now() - lastProbeAt > 30000;

  // A configured capability instance is direct evidence the gateway offers
  // that family — stronger than inferring it from a feature flag or endpoint
  // key, and the only signal available for a family the app has never heard
  // of (design spec §8).
  const instanceFamilies = new Set(capabilityInstances.map((instance) => instance.family));
  const isGroupReady = (definition: CapabilityGroupDef) =>
    Boolean(capabilities && groupIsAdvertised(definition, capabilities)) ||
    instanceFamilies.has(definition.id);

  const groups = CAPABILITY_GROUP_DEFS.map<import('@/lib/gateway/types').GatewayCapabilityGroup>(
    (definition) => {
      const groupCommands = definition.commandGroups
        ? commands.filter((command) => definition.commandGroups!.includes(command.group))
        : [];
      const totalCount = groupCommands.length;

      if (!connected) {
        return {
          id: definition.id,
          label: definition.label,
          status: 'unavailable',
          availableCount: 0,
          totalCount,
          note: 'Gateway offline',
        };
      }

      if (!capabilities) {
        return {
          id: definition.id,
          label: definition.label,
          status: 'unknown',
          availableCount: 0,
          totalCount,
          note: 'No capability catalog',
        };
      }

      const ready = isGroupReady(definition);
      return {
        id: definition.id,
        label: definition.label,
        status: ready ? 'ready' : 'unsupported',
        availableCount: ready ? totalCount : 0,
        totalCount,
        note: ready ? undefined : 'Not offered by this gateway',
      };
    },
  );

  // A family no built-in group covers gets its own group, so a capability
  // kind invented after this app shipped is still visible rather than
  // silently absent.
  const knownGroupIds = new Set(CAPABILITY_GROUP_DEFS.map((definition) => definition.id));
  const synthesizedGroups = [...instanceFamilies]
    .filter((family) => !knownGroupIds.has(family))
    .sort()
    .map<import('@/lib/gateway/types').GatewayCapabilityGroup>((family) => {
      const count = capabilityInstances.filter((instance) => instance.family === family).length;
      return {
        id: family,
        label: family.charAt(0).toUpperCase() + family.slice(1),
        status: connected ? 'ready' : 'unavailable',
        availableCount: connected ? count : 0,
        totalCount: count,
        note: connected ? undefined : 'Gateway offline',
      };
    });

  let overallStatus: import('@/lib/gateway/types').GatewayCapabilitySnapshot['status'];
  if (!connected) overallStatus = 'offline';
  else if (!capabilities) overallStatus = 'warming';
  else overallStatus = isStale ? 'stale' : 'fresh';

  const advertised = new Set(
    CAPABILITY_GROUP_DEFS.filter(isGroupReady).flatMap(
      (definition) => definition.commandGroups ?? [],
    ),
  );

  const methods: Record<string, import('@/lib/gateway/types').GatewayMethodAvailability> = {};
  commands.forEach((command) => {
    if (!connected) {
      methods[command.id] = { available: false, reason: 'offline' };
      return;
    }
    if (!capabilities) {
      methods[command.id] = { available: commandAllowed(command, hello) };
      return;
    }
    const available = advertised.has(command.group) && commandAllowed(command, hello);
    methods[command.id] = {
      available,
      reason: available ? undefined : 'not offered by this gateway',
    };
  });

  return {
    checkedAt: lastProbeAt,
    status: overallStatus,
    groups: [...groups, ...synthesizedGroups],
    methods,
    scopes,
  };
}

export function commandAllowed(command: GatewayCommand, hello: GatewayHelloOk | null): boolean {
  if (!command.requiredScope) return true;
  const scopes = hello?.auth?.scopes ?? [];
  if (scopes.length === 0) return true;
  return hasScope(scopes, command.requiredScope);
}

function hasScope(scopes: string[], required: string): boolean {
  if (scopes.includes('admin') || scopes.includes('operator.admin') || scopes.includes('*')) return true;
  if (scopes.includes(required)) return true;
  if (!required.startsWith('operator.') && scopes.includes(`operator.${required}`)) return true;
  if (required.startsWith('operator.') && scopes.includes(required.replace('operator.', ''))) return true;
  if (required === 'operator.read' && scopes.includes('operator.write')) return true;
  if (required === 'operator.read' && scopes.includes('operator.approvals')) return true;
  return false;
}

export function summarizeCommandResult(command: GatewayCommand, result: unknown): string {
  const record = isRecord(result) ? result : undefined;

  if (command.id === 'health') {
    const state = readString(record, 'status') ?? readString(record, 'state') ?? 'OK';
    return `Health: ${state}`;
  }

  if (command.id === 'status') {
    const version = readString(record, 'version') ?? readString(isRecord(record?.server) ? record.server : undefined, 'version');
    const state = readString(record, 'status') ?? readString(record, 'state') ?? 'online';
    return version ? `Status: ${state} - ${version}` : `Status: ${state}`;
  }

  if (command.id === 'sessions') {
    const sessions = readArray(record, 'sessions') ?? readArray(record, 'items') ?? readArray(record, 'data');
    if (sessions) return `Sessions: ${sessions.length}`;
  }

  if (command.id === 'channels') {
    const channels = readArray(record, 'channels') ?? readArray(record, 'items');
    if (channels) return `Channels: ${channels.length}`;
  }

  if (command.transport === 'agent') return `Sent to agent: ${command.agentCommand ?? command.label}`;
  return `${command.label}: complete`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readArray(record: Record<string, unknown> | undefined, key: string): unknown[] | undefined {
  const value = record?.[key];
  return Array.isArray(value) ? value : undefined;
}
