import type { ConnectionStatus, GatewayHelloOk } from '@/lib/gateway/types';

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
    id: 'skills',
    label: 'Skills',
    group: 'System',
    transport: 'rpc',
    method: 'skills.status',
    params: {},
    requiredScope: 'operator.read',
    danger: 'safe',
    slash: '/skills',
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
    group: 'System',
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

export function homeQuickCommands(): GatewayCommand[] {
  return GATEWAY_COMMANDS.filter((command) =>
    ['health', 'status', 'sessions', 'channels'].includes(command.id),
  );
}

export function rpcCommands(): GatewayCommand[] {
  return GATEWAY_COMMANDS.filter((command) => command.transport === 'rpc');
}

export function agentCommands(): GatewayCommand[] {
  return GATEWAY_COMMANDS.filter((command) => command.transport === 'agent');
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

// Phase 2: Live Capability Snapshot
export function buildCapabilitySnapshot(
  status: ConnectionStatus,
  hello: GatewayHelloOk | null,
  commands: GatewayCommand[] = GATEWAY_COMMANDS,
  lastProbeAt: number = Date.now(),
): import('@/lib/gateway/types').GatewayCapabilitySnapshot {
  const scopes = hello?.auth?.scopes ?? [];
  const connected = status === 'connected';
  const now = Date.now();
  const isStale = now - lastProbeAt > 30000; // 30s stale threshold

  const groups: import('@/lib/gateway/types').GatewayCapabilityGroup[] = [
    { id: 'chat', label: 'Chat', status: 'unknown' as any, availableCount: 0, totalCount: 1 },
    { id: 'agent', label: 'Agent', status: 'unknown' as any, availableCount: 0, totalCount: 3 },
    { id: 'terminal', label: 'Terminal', status: 'unknown' as any, availableCount: 0, totalCount: 1 },
    { id: 'sessions', label: 'Sessions', status: 'unknown' as any, availableCount: 0, totalCount: 1 },
    { id: 'channels', label: 'Channels', status: 'unknown' as any, availableCount: 0, totalCount: 2 },
    { id: 'approvals', label: 'Approvals', status: 'unknown' as any, availableCount: 0, totalCount: 1 },
    { id: 'config', label: 'Config', status: 'unknown' as any, availableCount: 0, totalCount: 3 },
    { id: 'models', label: 'Models', status: 'unknown' as any, availableCount: 0, totalCount: 4 },
    { id: 'plugins', label: 'Plugins', status: 'unknown' as any, availableCount: 0, totalCount: 2 },
    { id: 'logs', label: 'Logs', status: 'unknown' as any, availableCount: 0, totalCount: 1 },
    { id: 'diagnostics', label: 'Diagnostics', status: 'unknown' as any, availableCount: 0, totalCount: 4 },
    { id: 'cron', label: 'Cron', status: 'unknown' as any, availableCount: 0, totalCount: 1 },
    { id: 'environments', label: 'Environments', status: 'unknown' as any, availableCount: 0, totalCount: 1 },
    { id: 'skills', label: 'Skills', status: 'unknown' as any, availableCount: 0, totalCount: 1 },
    { id: 'artifacts', label: 'Artifacts', status: 'unknown' as any, availableCount: 0, totalCount: 1 },
    { id: 'tools', label: 'Tools', status: 'unknown' as any, availableCount: 0, totalCount: 2 },
    { id: 'devices', label: 'Devices', status: 'unknown' as any, availableCount: 0, totalCount: 1 },
    { id: 'nodes', label: 'Nodes', status: 'unknown' as any, availableCount: 0, totalCount: 1 },
    { id: 'voice', label: 'Voice/Talk', status: 'unknown' as any, availableCount: 0, totalCount: 2 },
  ];

  let overallStatus: import('@/lib/gateway/types').GatewayCapabilitySnapshot['status'] = 'offline';

  if (!connected) {
    overallStatus = 'offline';
  } else if (scopes.length === 0) {
    overallStatus = 'warming';
  } else {
    overallStatus = isStale ? 'stale' : 'fresh';
  }

  // Compute per group based on scopes + command registry
  groups.forEach((group) => {
    const famCommands = commands.filter((c) => {
      const fam = (c as any).family || (c as any).group || '';
      return fam.toLowerCase().includes(group.id) || group.id.includes(fam.toLowerCase());
    });

    const total = famCommands.length > 0 ? famCommands.length : (group.totalCount || 1);
    const allowed = famCommands.filter((c) => commandAllowed(c, hello)).length;

    let gstatus: any = 'unknown';

    if (!connected) {
      gstatus = 'offline';
    } else if (scopes.length === 0) {
      gstatus = 'warming';
    } else {
      const hasRequired = famCommands.some((c) => !c.requiredScope || commandAllowed(c, hello));
      if (allowed === 0 && famCommands.length > 0) {
        gstatus = 'missing-scope';
      } else if (allowed < total && famCommands.length > 0) {
        gstatus = 'partial';
      } else if (hasRequired) {
        gstatus = 'ready';
      } else {
        gstatus = 'unsupported';
      }
    }

    // Special cases
    if (group.id === 'voice' || group.id === 'talk') {
      gstatus = 'experimental';
    }

    group.status = gstatus;
    group.availableCount = allowed || (gstatus === 'ready' ? total : 0);
    group.totalCount = total;
    group.note = gstatus === 'ready' ? undefined : gstatus.replace('-', ' ');
  });

  // Build methods availability from registry
  const methods: Record<string, import('@/lib/gateway/types').GatewayMethodAvailability> = {};
  commands.forEach((cmd) => {
    const available = commandAllowed(cmd, hello);
    methods[cmd.id] = {
      available,
      reason: available ? undefined : (scopes.length === 0 ? 'warming' : 'missing scope'),
    };
  });

  return {
    checkedAt: lastProbeAt,
    status: overallStatus,
    groups,
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
