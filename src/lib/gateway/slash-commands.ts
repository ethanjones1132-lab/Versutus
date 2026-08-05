import {
  GATEWAY_COMMANDS,
  commandAllowed,
  summarizeCommandResult,
  type GatewayCommand,
} from '@/lib/gateway/dashboard';
import type { GatewayHelloOk } from '@/lib/gateway/types';

export type SlashCommandSuggestion = {
  value: string;
  label: string;
  description: string;
  danger: GatewayCommand['danger'] | 'local';
  family: string;
  unavailable: boolean;
  verification?: string;
};

export type SlashCommandResult = {
  text: string;
  title?: string;
  raw?: string;
};

type SlashCommandContext = {
  hello: GatewayHelloOk | null;
  gatewayRequest: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
  runAgentCommand: (
    command: string,
    options?: { onDelta?: (delta: string) => void },
  ) => Promise<string>;
  /** Stream agent-command output into the running command bubble. */
  onAgentDelta?: (delta: string) => void;
};

type ConfigSnapshot = {
  hash?: string;
  raw?: string;
  config?: unknown;
  parsed?: unknown;
  gatewaySource?: unknown;
  path?: string;
};

type ModelListOptions = {
  filters: string[];
  onlyAvailable: boolean;
  showAll: boolean;
  provider?: string;
};

type ModelValidation = {
  state: 'available' | 'locked' | 'missing' | 'unknown';
  label: string;
  matched?: unknown;
  catalog?: unknown;
  error?: string;
};

type AgentListSnapshot = {
  kind: 'record' | 'array' | 'unknown';
  agents: { id: string; value: unknown }[];
};

const LOCAL_SUGGESTIONS: SlashCommandSuggestion[] = [
  {
    value: '/help',
    label: '/help',
    description: 'Show chat commands',
    danger: 'local',
    family: 'Chat',
    unavailable: false,
  },
  {
    value: '/model',
    label: '/model',
    description: 'Show active default model',
    danger: 'local',
    family: 'Chat',
    unavailable: false,
  },
  {
    value: '/model set ',
    label: '/model set',
    description: 'Preview and update default model',
    danger: 'write',
    family: 'Models',
    unavailable: false,
  },
  {
    value: '/model agent ',
    label: '/model agent',
    description: 'Show per-agent model config',
    danger: 'local',
    family: 'Models',
    unavailable: false,
  },
  {
    value: '/model routing',
    label: '/model routing',
    description: 'Show model routing policy',
    danger: 'local',
    family: 'Models',
    unavailable: false,
  },
  {
    value: '/rpc ',
    label: '/rpc',
    description: 'Run a raw gateway RPC',
    danger: 'local',
    family: 'Other',
    unavailable: false,
  },
];

export function isSlashCommandInput(text: string): boolean {
  return text.trimStart().startsWith('/');
}

export function getSlashCommandSuggestions(
  input: string,
  hello: GatewayHelloOk | null,
): SlashCommandSuggestion[] {
  const needle = input.trimStart().toLowerCase();

  // Show all commands, mark unavailable
  const registrySuggestions = GATEWAY_COMMANDS.map((command) => {
    const available = command.slash && commandAllowed(command, hello);
    const fam = (command as any).family ?? (command as any).group ?? 'Other';
    return {
      value: command.slash ?? `/${command.id}`,
      label: command.slash ?? `/${command.id}`,
      description: command.description ?? command.label,
      danger: command.danger,
      family: fam,
      unavailable: !available,
      verification: (command as any).verification,
    };
  });

  // Local suggestions are always available
  const localWithMeta = LOCAL_SUGGESTIONS.map(s => ({
    ...s,
    family: 'Chat',
    unavailable: false,
  }));

  let suggestions = [...localWithMeta, ...registrySuggestions];

  if (needle) {
    // Simple fuzzy-ish filter: startsWith or includes
    suggestions = suggestions.filter((item) => {
      const v = item.value.toLowerCase();
      const l = item.label.toLowerCase();
      const d = item.description.toLowerCase();
      return v.startsWith(needle) || l.startsWith(needle) || v.includes(needle) || l.includes(needle) || d.includes(needle);
    });
  } else {
    // Default: hide /rpc unless explicitly typed, prefer safe ones
    suggestions = suggestions.filter(s => !s.value.toLowerCase().startsWith('/rpc'));
  }

  // Dedupe and limit
  suggestions = dedupeSuggestions(suggestions).slice(0, 12);

  return suggestions;
}

export async function executeGatewaySlashCommand(
  input: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  const trimmed = input.trim();
  const tokens = tokenizeCommand(trimmed);
  const commandName = tokens[0]?.toLowerCase();
  const args = tokens.slice(1);
  const argText = trimmed.slice(commandName?.length ?? 0).trim();

  if (!commandName || commandName === '/help') {
    const sub = args[0]?.toLowerCase();
    if (sub === 'all') return textResult(formatHelp(context.hello, 'all'), '/help all');
    if (sub === 'admin' || sub === 'write' || sub === 'destructive') return textResult(formatHelp(context.hello, 'admin'), '/help admin');
    if (sub) return textResult(formatHelp(context.hello, sub), `/help ${sub}`);
    return textResult(formatHelp(context.hello), '/help');
  }

  if (commandName === '/rpc') {
    return runRawRpc(argText, context);
  }

  if (commandName === '/agent') {
    return runAgentSubcommand(args, context);
  }

  if (commandName === '/model') {
    return runModelCommand(args, context);
  }

  if (commandName === '/config') {
    return runConfigCommand(args, context);
  }

  if (commandName === '/session') {
    return runSessionCommand(args, context);
  }

  if (commandName === '/channel') {
    return runChannelCommand(args, context);
  }

  if (commandName === '/approvals' || commandName === '/approval' || commandName === '/device') {
    return runApprovalsDevicesCommand(commandName, args, context);
  }

  if (commandName === '/logs') {
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'error' || sub === 'warn' || sub === 'boot') {
      const level = sub;
      const limit = clampNumber(Number(args[1]) || 20, 5, 100, 20);
      const result = await context.gatewayRequest('logs.tail', { level, limit }).catch(e => ({ error: String(e) }));
      return textResult(`${level} logs`, `/logs ${level}`, compactJson(result));
    }
    const limit = clampNumber(Number(args[0]), 10, 120, 40);
    return runRegistryCommand('logs', context, { limit, maxBytes: 16000 });
  }

  if (commandName === '/diagnostics') {
    const result = await context.gatewayRequest('diagnostics.full', {}).catch(e => ({ error: String(e) }));
    return textResult('Diagnostics summary', '/diagnostics', compactJson(result));
  }

  if (['/agents', '/tools', '/plugins', '/cron', '/env', '/skills', '/artifacts'].includes(commandName)) {
    return runAdvancedFamilyCommand(commandName, args, context);
  }

  if (commandName === '/talk' || commandName === '/voicewake') {
    return runVoiceCommand(commandName, args, context);
  }

  if (commandName === '/models') {
    return runModelsList(argText, context);
  }

  const command = findCommandBySlash(commandName);
  if (!command) {
    return textResult(`Unknown command: ${commandName}\n\n${formatHelp(context.hello)}`, commandName);
  }

  return runCommand(command, context);
}

function findCommandBySlash(value: string): GatewayCommand | undefined {
  return GATEWAY_COMMANDS.find((command) => {
    const slashes = [command.slash, ...(command.aliases ?? [])].filter(Boolean).map((item) => item?.toLowerCase());
    return slashes.includes(value.toLowerCase());
  });
}

async function runRegistryCommand(
  id: string,
  context: SlashCommandContext,
  params?: Record<string, unknown>,
): Promise<SlashCommandResult> {
  const command = GATEWAY_COMMANDS.find((item) => item.id === id);
  if (!command) return textResult(`Command not registered: ${id}`, id);
  return runCommand(command, context, params);
}

async function runCommand(
  command: GatewayCommand,
  context: SlashCommandContext,
  paramsOverride?: Record<string, unknown>,
): Promise<SlashCommandResult> {
  if (!commandAllowed(command, context.hello)) {
    return textResult(`${command.label} is not available for the active gateway scope.`, command.slash ?? command.label);
  }

  if (command.transport === 'agent') {
    const text = await context.runAgentCommand(command.agentCommand ?? command.label, {
      onDelta: context.onAgentDelta,
    });
    return textResult(text || summarizeCommandResult(command, {}), command.slash ?? command.label);
  }

  if (!command.method) return textResult(`${command.label}: missing RPC method`, command.slash ?? command.label);
  const result = await context.gatewayRequest(command.method, paramsOverride ?? command.params ?? {});
  return formatCommandResponse(command, result);
}

async function runRawRpc(argText: string, context: SlashCommandContext): Promise<SlashCommandResult> {
  const [method, rest] = splitFirstWord(argText);
  if (!method) return textResult('Usage: /rpc method {"optional":"params"}', '/rpc');

  const params = rest.trim() ? parseJsonParams(rest.trim()) : {};
  const result = await context.gatewayRequest(method, params);
  return textResult(`RPC ${method}: complete`, `/rpc ${method}`, compactJson(result));
}

async function runAgentSubcommand(args: string[], context: SlashCommandContext): Promise<SlashCommandResult> {
  const subcommand = args[0]?.toLowerCase();
  if (subcommand === 'status') return runRegistryCommand('agent-status', context);
  if (subcommand === 'stop') return runRegistryCommand('agent-stop', context);
  return textResult('Usage: /agent status or /agent stop', '/agent');
}

async function runModelCommand(args: string[], context: SlashCommandContext): Promise<SlashCommandResult> {
  const subcommand = args[0]?.toLowerCase();
  if (!subcommand || subcommand === 'show' || subcommand === 'status') {
    const snapshot = await readConfigSnapshot(context);
    return textResult(formatModelConfig(snapshot), '/model');
  }

  if (subcommand === 'auth') return runRegistryCommand('model-auth', context);

  if (subcommand === 'routing' || subcommand === 'policy') {
    const snapshot = await readConfigSnapshot(context);
    return textResult(formatModelRouting(snapshot), '/model routing', compactJson(readConfigObject(snapshot)));
  }

  if (subcommand === 'agent' || subcommand === 'agents') {
    const snapshot = await readConfigSnapshot(context);
    const agentId = args.slice(1).find((arg) => !arg.startsWith('--'));
    return textResult(formatAgentModels(snapshot, agentId), agentId ? `/model agent ${agentId}` : '/model agents', compactJson(readPath(readConfigObject(snapshot), 'agents')));
  }

  if (subcommand === 'set') {
    const modelId = args.slice(1).find((arg) => !arg.startsWith('--'));
    if (!modelId) return textResult('Usage: /model set provider/model-id --confirm', '/model set');
    const snapshot = await readConfigSnapshot(context);
    const validation = await validateModelId(modelId, context);
    const confirmed = args.includes('--confirm');
    const force = args.includes('--force');
    if (!confirmed) {
      return textResult(formatDefaultModelPreview(snapshot, modelId, validation), '/model set', compactJson(validation.matched ?? validation.catalog));
    }
    if (validation.state === 'missing' && !force) {
      return textResult(
        `Model not found in catalog: ${modelId}\nRun /models search ${modelId} or confirm with override:\n/model set ${modelId} --confirm --force`,
        '/model set',
        compactJson(validation.catalog),
      );
    }

    const baseHash = readBaseHash(snapshot);
    if (!baseHash) return textResult('Could not read the config base hash. Run /model and retry.', '/model set');

    const patch = { agents: { defaults: { model: { primary: modelId } } } };
    const result = await context.gatewayRequest('config.patch', {
      raw: JSON.stringify(patch, null, 2),
      baseHash,
    });
    return textResult(`Default model updated to ${modelId}\n${formatConfigWriteResult(result)}`, '/model set', compactJson(result));
  }

  if (subcommand === 'fallbacks') {
    const confirmed = args.includes('--confirm');
    const force = args.includes('--force');
    const values = args
      .slice(1)
      .filter((arg) => !arg.startsWith('--'))
      .flatMap((arg) => arg.split(','))
      .map((arg) => arg.trim())
      .filter(Boolean);

    if (values.length === 0) return textResult('Usage: /model fallbacks model-a,model-b --confirm', '/model fallbacks');
    const snapshot = await readConfigSnapshot(context);
    const validations = await Promise.all(values.map((value) => validateModelId(value, context)));
    const missing = validations.filter((validation) => validation.state === 'missing');
    if (!confirmed) {
      return textResult(formatFallbackPreview(snapshot, values, validations), '/model fallbacks', compactJson(validations.map((validation) => validation.matched ?? validation.error ?? validation.state)));
    }
    if (missing.length > 0 && !force) {
      return textResult(
        `Fallback model${missing.length === 1 ? '' : 's'} not found: ${missing.map((item) => item.label).join(', ')}\nRun /models search <query> or confirm with override:\n/model fallbacks ${values.join(',')} --confirm --force`,
        '/model fallbacks',
        compactJson(validations),
      );
    }

    const baseHash = readBaseHash(snapshot);
    if (!baseHash) return textResult('Could not read the config base hash. Run /model and retry.', '/model fallbacks');

    const patch = { agents: { defaults: { model: { fallbacks: values } } } };
    const result = await context.gatewayRequest('config.patch', {
      raw: JSON.stringify(patch, null, 2),
      baseHash,
      replacePaths: ['agents.defaults.model.fallbacks'],
    });
    return textResult(`Default model fallbacks updated\n${formatConfigWriteResult(result)}`, '/model fallbacks', compactJson(result));
  }

  if (subcommand === 'set-agent') {
    const agentId = args.slice(1).find((arg) => !arg.startsWith('--'));
    const modelId = args.slice(2).find((arg) => !arg.startsWith('--'));
    if (!agentId || !modelId) return textResult('Usage: /model set-agent <agent-id> <model-id> --confirm', '/model set-agent');

    const snapshot = await readConfigSnapshot(context);
    const validation = await validateModelId(modelId, context);
    const confirmed = args.includes('--confirm');
    const force = args.includes('--force');
    const patchPlan = buildAgentModelPatch(snapshot, agentId, modelId);
    if (!patchPlan) return textResult(`Agent not found: ${agentId}\nRun /model agents to inspect available agents.`, '/model set-agent');
    if (!confirmed) {
      return textResult(formatAgentModelPreview(snapshot, agentId, modelId, validation), '/model set-agent', compactJson(patchPlan));
    }
    if (validation.state === 'missing' && !force) {
      return textResult(
        `Model not found in catalog: ${modelId}\nRun /models search ${modelId} or confirm with override:\n/model set-agent ${agentId} ${modelId} --confirm --force`,
        '/model set-agent',
        compactJson(validation.catalog),
      );
    }

    const baseHash = readBaseHash(snapshot);
    if (!baseHash) return textResult('Could not read the config base hash. Run /model and retry.', '/model set-agent');
    const result = await context.gatewayRequest('config.patch', {
      raw: JSON.stringify(patchPlan.patch, null, 2),
      baseHash,
      ...(patchPlan.replacePaths.length ? { replacePaths: patchPlan.replacePaths } : {}),
    });
    return textResult(`Agent ${agentId} model updated to ${modelId}\n${formatConfigWriteResult(result)}`, '/model set-agent', compactJson(result));
  }

  return textResult('Usage: /model, /model auth, /model routing, /model agent <id>, /model set <model-id> --confirm, /model set-agent <agent-id> <model-id> --confirm, or /model fallbacks <ids> --confirm', '/model');
}

async function runConfigCommand(args: string[], context: SlashCommandContext): Promise<SlashCommandResult> {
  const subcommand = args[0]?.toLowerCase();
  if (subcommand === 'schema') {
    const path = args.slice(1).join(' ').trim();
    const result = path
      ? await context.gatewayRequest('config.schema.lookup', { path })
      : await context.gatewayRequest('config.schema', {});
    return textResult(`Config schema${path ? `: ${path}` : ''}`, '/config schema', compactJson(result));
  }

  if (subcommand === 'diff') {
    const result = await context.gatewayRequest('config.diff', {}).catch(() => ({}));
    return textResult('Config diff', '/config diff', compactJson(result));
  }

  if (subcommand === 'rollback') {
    const result = await context.gatewayRequest('config.rollback', {}).catch(() => ({}));
    return textResult('Config rolled back', '/config rollback', compactJson(result));
  }

  if (subcommand === 'last-good' || subcommand === 'lastgood') {
    const result = await context.gatewayRequest('config.last-good', {}).catch(() => ({}));
    return textResult('Last good config', '/config last-good', compactJson(result));
  }

  const snapshot = await readConfigSnapshot(context);
  const config = readConfigObject(snapshot);
  const path = args.join(' ').trim();
  if (!path) return textResult(formatConfigSummary(snapshot), '/config', compactJson(snapshot));
  const value = readPath(config, path);
  return value === undefined
    ? textResult(`Config path not found: ${path}`, '/config')
    : textResult(`Config ${path}`, `/config ${path}`, compactJson(value));
}

async function runSessionCommand(args: string[], context: SlashCommandContext): Promise<SlashCommandResult> {
  const sub = (args[0] || '').toLowerCase();
  const id = args[1];

  if (!sub || sub === 'current' || sub === 'status') {
    try {
      const result = await context.gatewayRequest('sessions.current', {});
      return textResult('Current session', '/session current', compactJson(result));
    } catch {
      return textResult('No current session or command not supported.', '/session current');
    }
  }

  if (sub === 'list') {
    return runRegistryCommand('sessions', context, { limit: 10 });
  }

  if (sub === 'get') {
    if (!id) return textResult('Usage: /session get <session-id>', '/session get');
    const result = await context.gatewayRequest('session.get', { sessionId: id }).catch(() => ({}));
    return textResult(`Session ${id}`, `/session get ${id}`, compactJson(result));
  }

  if (sub === 'messages') {
    if (!id) return textResult('Usage: /session messages <session-id>', '/session messages');
    const result = await context.gatewayRequest('session.messages', { sessionId: id, limit: 50 }).catch(() => ({}));
    return textResult(`Messages for session ${id}`, `/session messages ${id}`, compactJson(result));
  }

  if (sub === 'usage') {
    const params = id ? { sessionId: id } : {};
    const result = await context.gatewayRequest('session.usage', params).catch(() => ({}));
    return textResult('Session usage', '/session usage', compactJson(result));
  }

  // Dangerous actions - will be intercepted by confirmation in provider if danger=write
  if (sub === 'abort') {
    const params = id ? { sessionId: id } : {};
    const result = await context.gatewayRequest('session.abort', params).catch(e => ({ error: String(e) }));
    return textResult('Session abort requested', '/session abort', compactJson(result));
  }

  if (sub === 'compact') {
    const params = id ? { sessionId: id } : {};
    const result = await context.gatewayRequest('session.compact', params).catch(e => ({ error: String(e) }));
    return textResult('Session compact requested', '/session compact', compactJson(result));
  }

  if (sub === 'restore') {
    if (!id) return textResult('Usage: /session restore <session-id>', '/session restore');
    const result = await context.gatewayRequest('session.restore', { sessionId: id }).catch(e => ({ error: String(e) }));
    return textResult(`Restore session ${id}`, `/session restore ${id}`, compactJson(result));
  }

  return textResult(
    'Usage: /session current | list | get <id> | messages <id> | usage [id] | abort [id] | compact [id] | restore <id>',
    '/session'
  );
}

async function runChannelCommand(args: string[], context: SlashCommandContext): Promise<SlashCommandResult> {
  const sub = (args[0] || '').toLowerCase();
  const name = args[1];

  if (!sub) {
    return runRegistryCommand('channels', context);
  }

  if (sub === 'start') {
    if (!name) return textResult('Usage: /channel start <name>', '/channel start');
    const result = await context.gatewayRequest('channel.start', { name }).catch(e => ({ error: String(e) }));
    return textResult(`Channel ${name} start requested`, `/channel start ${name}`, compactJson(result));
  }

  if (sub === 'stop') {
    if (!name) return textResult('Usage: /channel stop <name>', '/channel stop');
    const result = await context.gatewayRequest('channel.stop', { name }).catch(e => ({ error: String(e) }));
    return textResult(`Channel ${name} stop requested`, `/channel stop ${name}`, compactJson(result));
  }

  if (sub === 'logout') {
    if (!name) return textResult('Usage: /channel logout <name>', '/channel logout');
    const result = await context.gatewayRequest('channel.logout', { name }).catch(e => ({ error: String(e) }));
    return textResult(`Channel ${name} logout requested`, `/channel logout ${name}`, compactJson(result));
  }

  return textResult('Usage: /channel [status] | start <name> | stop <name> | logout <name>', '/channel');
}

async function runApprovalsDevicesCommand(commandName: string, args: string[], context: SlashCommandContext): Promise<SlashCommandResult> {
  if (commandName === '/approvals') {
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'pending') {
      const result = await context.gatewayRequest('approvals.pending', {}).catch(e => ({ error: String(e) }));
      return textResult('Pending approvals', '/approvals pending', compactJson(result));
    }
    return runRegistryCommand('approvals', context);
  }

  if (commandName === '/approval') {
    const action = (args[0] || '').toLowerCase();
    const id = args[1];
    if (!id) return textResult(`Usage: /approval ${action} <id>`, `/approval ${action}`);
    const method = action === 'approve' ? 'approval.approve' : 'approval.deny';
    const result = await context.gatewayRequest(method, { id }).catch(e => ({ error: String(e) }));
    return textResult(`Approval ${action} for ${id}`, `/approval ${action} ${id}`, compactJson(result));
  }

  if (commandName === '/device') {
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'repair') {
      const result = await context.gatewayRequest('device.repair', {}).catch(e => ({ error: String(e) }));
      return textResult('Device token repair attempted', '/device repair', compactJson(result));
    }
    const result = await context.gatewayRequest('device.info', {}).catch(e => ({ error: String(e) }));
    return textResult('Device info', '/device', compactJson(result));
  }

  return textResult('Unknown approvals/devices command', commandName);
}

async function runAdvancedFamilyCommand(commandName: string, args: string[], context: SlashCommandContext): Promise<SlashCommandResult> {
  const sub = (args[0] || '').toLowerCase();
  let method = '';
  let title = commandName;

  switch (commandName) {
    case '/agents':
      method = sub ? 'agent.get' : 'agents.list';
      title = sub ? `Agent ${sub}` : 'Agents';
      break;
    case '/tools':
      method = sub === 'effective' ? 'tools.effective' : 'tools.list';
      title = 'Tools';
      break;
    case '/plugins':
      method = sub ? 'plugin.get' : 'plugins.list';
      title = 'Plugins';
      break;
    case '/cron':
      method = sub === 'history' ? 'cron.history' : 'cron.list';
      title = 'Cron';
      break;
    case '/env':
      method = sub ? 'env.get' : 'environments.list';
      title = 'Environments';
      break;
    case '/skills':
      method = sub ? 'skill.get' : 'skills.list';
      title = 'Skills';
      break;
    case '/artifacts':
      method = sub ? 'artifact.get' : 'artifacts.list';
      title = 'Artifacts';
      break;
  }

  if (!method) method = commandName.replace('/', '').replace('-', '.') + '.list';

  const params = sub ? { id: sub } : {};
  const result = await context.gatewayRequest(method, params).catch(e => ({ error: String(e) }));
  return textResult(title, commandName, compactJson(result));
}

async function runVoiceCommand(commandName: string, args: string[], context: SlashCommandContext): Promise<SlashCommandResult> {
  if (commandName === '/talk') {
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'catalog' || sub === 'config' || sub === 'mode') {
      const result = await context.gatewayRequest(`talk.${sub}`, {}).catch(e => ({ error: String(e) }));
      return textResult(`Talk ${sub}`, `/talk ${sub}`, compactJson(result));
    }
    return textResult('Usage: /talk catalog | config | mode', '/talk');
  }

  if (commandName === '/voicewake') {
    const result = await context.gatewayRequest('voicewake.status', {}).catch(e => ({ error: String(e) }));
    return textResult('VoiceWake status', '/voicewake', compactJson(result));
  }

  return textResult('Voice/Talk commands are read-first only at this stage.', commandName);
}

async function runModelsList(filterText: string, context: SlashCommandContext): Promise<SlashCommandResult> {
  const result = await context.gatewayRequest('models.list', {});
  return textResult(formatModelsList(result, parseModelListOptions(filterText)), '/models', compactJson(result));
}

async function readConfigSnapshot(context: SlashCommandContext): Promise<ConfigSnapshot> {
  return context.gatewayRequest<ConfigSnapshot>('config.get', {});
}

function readBaseHash(snapshot: ConfigSnapshot): string | undefined {
  return typeof snapshot.hash === 'string' && snapshot.hash.trim() ? snapshot.hash.trim() : undefined;
}

function readConfigObject(snapshot: ConfigSnapshot): unknown {
  return snapshot.config ?? snapshot.gatewaySource ?? snapshot.parsed;
}

function formatHelp(hello: GatewayHelloOk | null, filter?: string): string {
  const isAdmin = filter === 'admin' || filter === 'write' || filter === 'destructive';
  const familyFilter = filter && !['all', 'admin', 'write', 'destructive'].includes(filter) ? filter : undefined;

  let list = GATEWAY_COMMANDS.filter((command) => command.slash && commandAllowed(command, hello));

  if (familyFilter) {
    list = list.filter((c) => (c as any).group?.toLowerCase?.() === familyFilter || (c as any).family?.toLowerCase?.() === familyFilter);
  }
  if (isAdmin) {
    list = list.filter((c) => c.danger === 'write' || c.danger === 'destructive');
  }

  const lines = list.map((command) => {
    const danger = command.danger !== 'safe' ? ` [${command.danger}]` : '';
    const scope = command.requiredScope ? ` (${command.requiredScope})` : '';
    return `${command.slash}${danger}${scope} — ${command.description ?? command.label}`;
  });

  const base = [
    'Available commands',
    '/help — this help',
    '/help all — everything',
    '/help admin — write/destructive only',
    '/help <family> — e.g. sessions, models, config',
    '/rpc <method> [json] — raw escape hatch (advanced)',
    '',
  ];

  if (lines.length === 0) {
    return [...base, 'No matching commands for current scope.'].join('\n');
  }

  return [...base, ...lines].join('\n');
}

function formatCommandResponse(command: GatewayCommand, result: unknown): SlashCommandResult {
  const summary = command.transport === 'agent'
    ? summarizeCommandResult(command, result)
    : formatRegisteredCommandResult(command, result);
  const details = compactJson(result);
  return textResult(summary, command.slash ?? command.label, details === '{}' ? undefined : details);
}

function formatRegisteredCommandResult(command: GatewayCommand, result: unknown): string {
  switch (command.id) {
    case 'health':
      return formatGatewayHealth(result);
    case 'status':
      return formatGatewayStatus(result);
    case 'sessions':
      return formatSessions(result);
    case 'channels':
      return formatChannels(result);
    case 'usage':
      return formatUsage(result);
    case 'cost':
      return formatCost(result);
    case 'stability':
      return formatStability(result);
    case 'logs':
      return formatLogs(result);
    case 'model-auth':
      return formatModelAuth(result);
    case 'plugins':
      return formatPlugins(result);
    case 'approvals':
      return formatApprovals(result);
    case 'memory':
      return formatMemory(result);
    case 'skills':
      return formatSkills(result);
    case 'environments':
      return formatEnvironments(result);
    case 'cron':
      return formatCron(result);
    default:
      return summarizeCommandResult(command, result);
  }
}

function formatGatewayHealth(result: unknown): string {
  const record = isRecord(result) ? result : {};
  const state = readFirstString(record, ['status', 'state', 'health']) ?? (readFirstBoolean(record, ['ok', 'healthy']) === false ? 'not healthy' : 'OK');
  const version = readFirstString(record, ['version']);
  const uptime = readFirstNumber(record, ['uptimeMs', 'uptime_ms', 'uptime']);
  return [
    `Health: ${state}`,
    version ? `Version: ${version}` : undefined,
    uptime !== undefined ? `Uptime: ${formatDuration(uptime)}` : undefined,
  ].filter(Boolean).join('\n');
}

function formatGatewayStatus(result: unknown): string {
  const record = isRecord(result) ? result : {};
  const server = isRecord(record.server) ? record.server : {};
  const state = readFirstString(record, ['status', 'state']) ?? readFirstString(server, ['status', 'state']) ?? 'online';
  const version = readFirstString(record, ['version']) ?? readFirstString(server, ['version']);
  const mode = readFirstString(record, ['mode', 'authMode', 'auth']);
  const lines = [`Status: ${state}`];
  if (version) lines.push(`Version: ${version}`);
  if (mode) lines.push(`Mode: ${mode}`);
  return lines.join('\n');
}

function formatSessions(result: unknown): string {
  const sessions = readCollection(result, ['sessions', 'items', 'data']);
  if (!sessions?.length) return 'Sessions: none reported';
  const lines = sessions.slice(0, 6).map((item) => describeNamedRecord(item, ['id', 'sessionId', 'name', 'title'], ['status', 'state', 'agent', 'updatedAt']));
  return [`Sessions: ${sessions.length}`, ...lines].join('\n');
}

function formatChannels(result: unknown): string {
  const channels = readCollection(result, ['channels', 'items', 'data']);
  if (!channels?.length) return 'Channels: none reported';

  const lines = channels.slice(0, 10).map((item) => {
    if (!isRecord(item)) return describeNamedRecord(item, ['name', 'id', 'channel'], ['status', 'state', 'connected', 'account']);

    const name = readFirstString(item, ['name', 'id', 'channel']) ?? 'unknown';
    const status = readFirstString(item, ['status', 'state', 'connected']) ?? 'unknown';
    const account = readFirstString(item, ['account', 'user', 'handle']);
    const warmup = readFirstBoolean(item, ['warming', 'warmup', 'connecting']);
    const lastError = readFirstString(item, ['lastError', 'error', 'last_error']);
    const remediation = readFirstString(item, ['remediation', 'hint', 'fix']);

    let line = `- ${name}: ${status}`;
    if (account) line += ` (${account})`;
    if (warmup) line += ' (warming)';
    if (lastError) line += ` - error: ${lastError}`;
    if (remediation) line += ` | fix: ${remediation}`;

    return line;
  });

  return [`Channels: ${channels.length}`, ...lines].join('\n');
}

function formatUsage(result: unknown): string {
  const record = isRecord(result) ? result : {};
  const requests = readFirstNumber(record, ['requests', 'requestCount', 'calls', 'totalRequests']);
  const tokens = readFirstNumber(record, ['tokens', 'totalTokens', 'tokenCount']);
  const prompt = readFirstNumber(record, ['promptTokens', 'inputTokens']);
  const completion = readFirstNumber(record, ['completionTokens', 'outputTokens']);
  const period = readFirstString(record, ['period', 'window', 'range']);
  const lines = ['Usage'];
  if (period) lines.push(`Window: ${period}`);
  if (requests !== undefined) lines.push(`Requests: ${formatCount(requests)}`);
  if (tokens !== undefined) lines.push(`Tokens: ${formatCount(tokens)}`);
  if (prompt !== undefined || completion !== undefined) {
    lines.push(`In/out: ${formatCount(prompt ?? 0)} / ${formatCount(completion ?? 0)}`);
  }
  return lines.length > 1 ? lines.join('\n') : summarizeRecord('Usage', result);
}

function formatCost(result: unknown): string {
  const record = isRecord(result) ? result : {};
  const cost = readFirstNumber(record, ['cost', 'totalCost', 'usd', 'costUsd', 'totalUsd', 'estimatedCost']);
  const currency = readFirstString(record, ['currency']) ?? 'USD';
  const period = readFirstString(record, ['period', 'window', 'range']);
  const lines = ['Cost'];
  if (period) lines.push(`Window: ${period}`);
  if (cost !== undefined) lines.push(`Total: ${currency === 'USD' ? '$' : `${currency} `}${formatDecimal(cost)}`);
  return lines.length > 1 ? lines.join('\n') : summarizeRecord('Cost', result);
}

function formatStability(result: unknown): string {
  const record = isRecord(result) ? result : {};
  const state = readFirstString(record, ['status', 'state', 'stability']) ?? 'reported';
  const restarts = readFirstNumber(record, ['restarts', 'restartCount']);
  const errors = readFirstNumber(record, ['errors', 'errorCount', 'recentErrors']);
  const lines = [`Stability: ${state}`];
  if (restarts !== undefined) lines.push(`Restarts: ${formatCount(restarts)}`);
  if (errors !== undefined) lines.push(`Recent errors: ${formatCount(errors)}`);
  return lines.join('\n');
}

function formatLogs(result: unknown): string {
  const record = isRecord(result) ? result : {};
  const linesFromString = readFirstString(record, ['text', 'log', 'logs'])?.split(/\r?\n/).filter(Boolean);
  const entries = readCollection(result, ['lines', 'logs', 'items', 'events']) ?? linesFromString;
  if (!entries?.length) return 'Logs: no recent entries';
  const lines = entries.slice(-8).map((item) => {
    if (typeof item === 'string') return truncateLine(item, 150);
    const entry = isRecord(item) ? item : {};
    const level = readFirstString(entry, ['level', 'severity']);
    const message = readFirstString(entry, ['message', 'msg', 'text', 'line']) ?? compactJson(item).replace(/\s+/g, ' ');
    return truncateLine([level ? `[${level}]` : undefined, message].filter(Boolean).join(' '), 150);
  });
  return [`Logs: last ${lines.length}`, ...lines].join('\n');
}

function formatModelAuth(result: unknown): string {
  const providers = readCollection(result, ['providers', 'auth', 'items', 'data']);
  if (!providers?.length) return summarizeRecord('Model auth', result);
  const lines = providers.slice(0, 10).map((item) => describeNamedRecord(item, ['provider', 'name', 'id'], ['status', 'state', 'authenticated', 'configured', 'available']));
  return [`Model auth: ${providers.length} provider${providers.length === 1 ? '' : 's'}`, ...lines].join('\n');
}

function formatPlugins(result: unknown): string {
  const plugins = readCollection(result, ['plugins', 'descriptors', 'items', 'data']);
  if (!plugins?.length) return 'Plugins: none reported';
  const lines = plugins.slice(0, 10).map((item) => describeNamedRecord(item, ['name', 'id', 'pluginId', 'title'], ['enabled', 'status', 'state', 'version']));
  return [`Plugins: ${plugins.length}`, ...lines].join('\n');
}

function formatApprovals(result: unknown): string {
  const record = isRecord(result) ? result : {};
  const pending = readCollection(result, ['pending', 'requests', 'items']);
  const policy = readFirstString(record, ['policy', 'mode', 'default']);
  const path = readFirstString(record, ['path', 'file']);
  const hash = readFirstString(record, ['hash']);
  const lines = ['Approvals'];
  if (pending) lines.push(`Pending: ${pending.length}`);
  if (policy) lines.push(`Policy: ${policy}`);
  if (path) lines.push(`Path: ${path}`);
  if (hash) lines.push(`Hash: ${hash.slice(0, 12)}`);
  return lines.length > 1 ? lines.join('\n') : summarizeRecord('Approvals', result);
}

function formatMemory(result: unknown): string {
  return formatStatusCollection('Memory', result, ['items', 'checks', 'stores'], ['status', 'state', 'ok', 'healthy']);
}

function formatSkills(result: unknown): string {
  return formatStatusCollection('Skills', result, ['skills', 'items', 'available', 'installed'], ['status', 'state', 'enabled', 'available']);
}

function formatEnvironments(result: unknown): string {
  return formatStatusCollection('Environments', result, ['environments', 'items', 'envs'], ['status', 'state', 'ready', 'healthy']);
}

function formatCron(result: unknown): string {
  const record = isRecord(result) ? result : {};
  const running = readFirstBoolean(record, ['running', 'enabled', 'active']);
  const jobs = readCollection(result, ['jobs', 'crons', 'items']);
  const lines = ['Cron'];
  if (running !== undefined) lines.push(`Runner: ${running ? 'running' : 'stopped'}`);
  if (jobs) lines.push(`Jobs: ${jobs.length}`);
  return lines.length > 1 ? lines.join('\n') : summarizeRecord('Cron', result);
}

function formatStatusCollection(title: string, result: unknown, collectionKeys: string[], statusKeys: string[]): string {
  const record = isRecord(result) ? result : {};
  const state = readFirstString(record, statusKeys) ?? readFirstBoolean(record, statusKeys)?.toString();
  const items = readCollection(result, collectionKeys);
  const lines = [state ? `${title}: ${state}` : title];
  if (items) lines.push(`Items: ${items.length}`);
  if (items?.length) {
    lines.push(...items.slice(0, 6).map((item) => describeNamedRecord(item, ['name', 'id', 'key', 'title'], statusKeys)));
  }
  return lines.length > 1 ? lines.join('\n') : summarizeRecord(title, result);
}

function textResult(text: string, title?: string, raw?: string): SlashCommandResult {
  return { text, title, raw };
}

function formatModelConfig(snapshot: ConfigSnapshot): string {
  const model = readPath(readConfigObject(snapshot), 'agents.defaults.model');
  const record = isRecord(model) ? model : {};
  const primary = readString(record, 'primary') ?? 'not set';
  const fallbacks = readArray(record, 'fallbacks')?.filter((item): item is string => typeof item === 'string') ?? [];
  return [
    'Default model',
    `Primary: ${primary}`,
    `Fallbacks: ${fallbacks.length ? fallbacks.join(', ') : 'none'}`,
    snapshot.path ? `Config: ${snapshot.path}` : undefined,
  ].filter(Boolean).join('\n');
}

function formatModelRouting(snapshot: ConfigSnapshot): string {
  const config = readConfigObject(snapshot);
  const defaults = readPath(config, 'agents.defaults.model');
  const defaultRecord = isRecord(defaults) ? defaults : {};
  const agents = readAgentListSnapshot(config).agents;
  const routing = readPath(config, 'models.routing') ?? readPath(config, 'modelRouting') ?? readPath(config, 'routing.models');
  const primary = readString(defaultRecord, 'primary') ?? (typeof defaults === 'string' ? defaults : 'not set');
  const fallbacks = readArray(defaultRecord, 'fallbacks')?.filter((item): item is string => typeof item === 'string') ?? [];
  const lines = [
    'Model routing',
    `Default: ${primary}`,
    `Fallbacks: ${fallbacks.length ? fallbacks.join(', ') : 'none'}`,
    `Agents with overrides: ${agents.filter((agent) => readAgentModel(agent.value) !== undefined).length}/${agents.length}`,
  ];

  if (isRecord(routing)) {
    const keys = Object.keys(routing).slice(0, 6);
    if (keys.length) lines.push(`Routing keys: ${keys.join(', ')}`);
  }

  return lines.join('\n');
}

function formatAgentModels(snapshot: ConfigSnapshot, agentId?: string): string {
  const agents = readAgentListSnapshot(readConfigObject(snapshot)).agents;
  if (!agents.length) return 'No agent model configuration found.';

  if (agentId) {
    const agent = agents.find((item) => item.id === agentId);
    if (!agent) return `Agent not found: ${agentId}`;
    return [
      `Agent model: ${agent.id}`,
      `Model: ${readAgentModel(agent.value) ?? 'inherits default'}`,
      `Tools: ${readPath(agent.value, 'tools.profile') ?? 'not set'}`,
    ].join('\n');
  }

  const lines = agents.slice(0, 12).map((agent) => `- ${agent.id}: ${readAgentModel(agent.value) ?? 'inherits default'}`);
  return [`Agent models: ${agents.length}`, ...lines].join('\n');
}

function formatDefaultModelPreview(snapshot: ConfigSnapshot, modelId: string, validation: ModelValidation): string {
  const current = readDefaultPrimaryModel(snapshot) ?? 'not set';
  return [
    'Default model change preview',
    `Current: ${current}`,
    `Next: ${modelId}`,
    `Catalog: ${formatValidationState(validation)}`,
    'Run to apply:',
    `/model set ${modelId} --confirm${validation.state === 'missing' ? ' --force' : ''}`,
  ].join('\n');
}

function formatFallbackPreview(snapshot: ConfigSnapshot, values: string[], validations: ModelValidation[]): string {
  const current = readDefaultFallbacks(snapshot);
  return [
    'Fallback model change preview',
    `Current: ${current.length ? current.join(', ') : 'none'}`,
    `Next: ${values.join(', ')}`,
    ...validations.map((validation) => `Catalog ${validation.label}: ${formatValidationState(validation)}`),
    'Run to apply:',
    `/model fallbacks ${values.join(',')} --confirm${validations.some((validation) => validation.state === 'missing') ? ' --force' : ''}`,
  ].join('\n');
}

function formatAgentModelPreview(
  snapshot: ConfigSnapshot,
  agentId: string,
  modelId: string,
  validation: ModelValidation,
): string {
  const agents = readAgentListSnapshot(readConfigObject(snapshot)).agents;
  const agent = agents.find((item) => item.id === agentId);
  return [
    'Agent model change preview',
    `Agent: ${agentId}`,
    `Current: ${agent ? readAgentModel(agent.value) ?? 'inherits default' : 'not found'}`,
    `Next: ${modelId}`,
    `Catalog: ${formatValidationState(validation)}`,
    'Run to apply:',
    `/model set-agent ${agentId} ${modelId} --confirm${validation.state === 'missing' ? ' --force' : ''}`,
  ].join('\n');
}

function formatConfigSummary(snapshot: ConfigSnapshot): string {
  const config = readConfigObject(snapshot);
  const model = readPath(config, 'agents.defaults.model');
  const primary = isRecord(model) ? readString(model, 'primary') : undefined;
  const lines = ['Config snapshot'];
  if (snapshot.path) lines.push(`Path: ${snapshot.path}`);
  if (snapshot.hash) lines.push(`Hash: ${snapshot.hash.slice(0, 12)}`);
  if (primary) lines.push(`Default model: ${primary}`);
  return lines.join('\n');
}

function formatConfigWriteResult(result: unknown): string {
  const record = isRecord(result) ? result : {};
  const restart = isRecord(record.restart) ? record.restart : undefined;
  const queued = readBoolean(restart, 'queued') ?? readBoolean(restart, 'required');
  const path = readString(record, 'path');
  const lines = ['Config write complete'];
  if (path) lines.push(`Path: ${path}`);
  if (queued !== undefined) lines.push(`Restart queued: ${queued ? 'yes' : 'no'}`);
  return lines.join('\n');
}

async function validateModelId(modelId: string, context: SlashCommandContext): Promise<ModelValidation> {
  try {
    const catalog = await context.gatewayRequest('models.list', {});
    const models = readModelItems(catalog);
    if (models.length === 0) return { state: 'unknown', label: modelId, catalog };

    const match = models.find((item) => modelIdentifiers(item).includes(modelId.toLowerCase()));
    if (!match) return { state: 'missing', label: modelId, catalog };
    const record = isRecord(match) ? match : {};
    const available = readModelAvailable(record);
    return {
      state: available === false ? 'locked' : 'available',
      label: modelId,
      matched: match,
      catalog,
    };
  } catch (error) {
    return {
      state: 'unknown',
      label: modelId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function readModelItems(catalog: unknown): unknown[] {
  const record = isRecord(catalog) ? catalog : undefined;
  return readArray(record, 'models') ?? readArray(record, 'items') ?? readCollection(catalog, ['models', 'items', 'data']) ?? [];
}

function modelIdentifiers(value: unknown): string[] {
  if (!isRecord(value)) return [String(value).toLowerCase()];
  return [
    readString(value, 'id'),
    readString(value, 'model'),
    readString(value, 'name'),
    readString(value, 'slug'),
  ].filter((item): item is string => typeof item === 'string' && item.length > 0).map((item) => item.toLowerCase());
}

function formatValidationState(validation: ModelValidation): string {
  if (validation.state === 'available') return 'found';
  if (validation.state === 'locked') return 'found but not ready';
  if (validation.state === 'missing') return 'not found';
  return validation.error ? `unknown (${truncateLine(validation.error, 90)})` : 'unknown';
}

function readDefaultPrimaryModel(snapshot: ConfigSnapshot): string | undefined {
  const model = readPath(readConfigObject(snapshot), 'agents.defaults.model');
  if (typeof model === 'string' && model.trim()) return model.trim();
  return isRecord(model) ? readString(model, 'primary') : undefined;
}

function readDefaultFallbacks(snapshot: ConfigSnapshot): string[] {
  const model = readPath(readConfigObject(snapshot), 'agents.defaults.model');
  if (!isRecord(model)) return [];
  return readArray(model, 'fallbacks')?.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) ?? [];
}

function readAgentListSnapshot(config: unknown): AgentListSnapshot {
  const list = readPath(config, 'agents.list');
  if (Array.isArray(list)) {
    return {
      kind: 'array',
      agents: list.map((value, index) => ({
        id: readAgentId(value) ?? `agent-${index + 1}`,
        value,
      })),
    };
  }

  if (isRecord(list)) {
    return {
      kind: 'record',
      agents: Object.entries(list).map(([id, value]) => ({
        id,
        value: isRecord(value) ? { id, ...value } : value,
      })),
    };
  }

  return { kind: 'unknown', agents: [] };
}

function readAgentId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return readFirstString(value, ['id', 'name', 'agentId']);
}

function readAgentModel(value: unknown): string | undefined {
  const model = readPath(value, 'model');
  if (typeof model === 'string' && model.trim()) return model.trim();
  if (isRecord(model)) {
    return readString(model, 'primary') ?? readString(model, 'id') ?? readString(model, 'model');
  }
  const nested = readPath(value, 'models.primary');
  return typeof nested === 'string' && nested.trim() ? nested.trim() : undefined;
}

function buildAgentModelPatch(
  snapshot: ConfigSnapshot,
  agentId: string,
  modelId: string,
): { patch: Record<string, unknown>; replacePaths: string[] } | undefined {
  const config = readConfigObject(snapshot);
  const list = readPath(config, 'agents.list');
  const listSnapshot = readAgentListSnapshot(config);
  const target = listSnapshot.agents.find((agent) => agent.id === agentId);
  if (!target) return undefined;

  if (listSnapshot.kind === 'record') {
    const currentModel = readPath(target.value, 'model');
    const nextModel = isRecord(currentModel) ? { ...currentModel, primary: modelId } : modelId;
    return {
      patch: {
        agents: {
          list: {
            [agentId]: {
              model: nextModel,
            },
          },
        },
      },
      replacePaths: [],
    };
  }

  if (Array.isArray(list)) {
    const nextList = list.map((item) => {
      const id = readAgentId(item);
      if (id !== agentId || !isRecord(item)) return item;
      const currentModel = readPath(item, 'model');
      return {
        ...item,
        model: isRecord(currentModel) ? { ...currentModel, primary: modelId } : modelId,
      };
    });
    return {
      patch: { agents: { list: nextList } },
      replacePaths: ['agents.list'],
    };
  }

  return undefined;
}

function parseModelListOptions(value: string): ModelListOptions {
  const args = tokenizeCommand(value);
  const options: ModelListOptions = { filters: [], onlyAvailable: false, showAll: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]?.toLowerCase();
    if (!arg) continue;

    if (arg === 'all' || arg === '--all') {
      options.showAll = true;
      continue;
    }

    if (arg === 'available' || arg === 'ready' || arg === '--available') {
      options.onlyAvailable = true;
      continue;
    }

    if (arg === 'provider') {
      const provider = args[index + 1]?.trim();
      if (provider) {
        options.provider = provider.toLowerCase();
        index += 1;
      }
      continue;
    }

    if (arg === 'search') continue;
    options.filters.push(args[index]);
  }

  return options;
}

function formatModelsList(result: unknown, options: ModelListOptions): string {
  const record = isRecord(result) ? result : {};
  const models = readArray(record, 'models') ?? readArray(record, 'items') ?? [];
  const filters = options.filters.map((item) => item.toLowerCase());
  const visible = models
    .filter((item) => {
      const model = isRecord(item) ? item : {};
      const available = readModelAvailable(model);
      const provider = readString(model, 'provider')?.toLowerCase();
      if (options.onlyAvailable && available === false) return false;
      if (options.provider && provider !== options.provider) return false;
      return filters.length === 0 || filters.every((filter) => modelSearchText(item).includes(filter));
    })
    .slice(0, options.showAll ? 40 : 14);

  if (visible.length === 0) return 'No models matched.';

  const lines = visible.map((item) => {
    const model = isRecord(item) ? item : {};
    const id = readString(model, 'id') ?? readString(model, 'model') ?? readString(model, 'name') ?? 'unknown';
    const provider = readString(model, 'provider');
    const available = readAvailabilityLabel(model);
    return [id, provider ? `(${provider})` : undefined, available ? `- ${available}` : undefined].filter(Boolean).join(' ');
  }).map((line, index) => {
    const model = isRecord(visible[index]) ? visible[index] : {};
    const context = readNumber(model, 'context') ?? readNumber(model, 'contextLength') ?? readNumber(model, 'context_length');
    const price = readNumber(model, 'cost') ?? readNumber(model, 'price') ?? readNumber(model, 'inputPrice');
    return [
      line,
      context ? `ctx ${formatCount(context)}` : undefined,
      price !== undefined ? `$${formatDecimal(price)}` : undefined,
    ].filter(Boolean).join(' - ');
  });

  const qualifiers = [
    options.onlyAvailable ? 'available' : undefined,
    options.provider ? `provider ${options.provider}` : undefined,
    filters.length ? `search ${filters.join(' ')}` : undefined,
  ].filter(Boolean);

  return [
    `Models${qualifiers.length ? ` (${qualifiers.join(', ')})` : ''}: ${visible.length}${models.length > visible.length ? ` of ${models.length}` : ''}`,
    ...lines,
  ].join('\n');
}

function modelSearchText(value: unknown): string {
  if (!isRecord(value)) return String(value).toLowerCase();
  return [
    readString(value, 'id'),
    readString(value, 'model'),
    readString(value, 'name'),
    readString(value, 'provider'),
    readString(value, 'label'),
  ].filter(Boolean).join(' ').toLowerCase();
}

function readCollection(value: unknown, keys: string[]): unknown[] | undefined {
  const candidates: { value: unknown; keyed: boolean }[] = [];
  const record = isRecord(value) ? value : undefined;
  keys.forEach((key) => {
    if (record && key in record) candidates.push({ value: record[key], keyed: true });
  });
  candidates.push({ value, keyed: false });

  for (const candidateEntry of candidates) {
    const candidate = candidateEntry.value;
    if (Array.isArray(candidate)) return candidate;
    if (typeof candidate === 'string' && candidate.trim()) return candidate.split(/\r?\n/).filter(Boolean);
    if (isRecord(candidate)) {
      const entries = Object.entries(candidate);
      if (entries.length === 0) continue;
      const keyedList = candidateEntry.keyed && entries.every(([, item]) => isRecord(item) || typeof item !== 'object');
      const recordList = !candidateEntry.keyed && entries.every(([, item]) => isRecord(item));
      if (keyedList || recordList) {
        return entries.map(([key, item]) => isRecord(item) ? { name: key, ...item } : { name: key, value: item });
      }
    }
  }

  return undefined;
}

function describeNamedRecord(value: unknown, nameKeys: string[], detailKeys: string[]): string {
  if (!isRecord(value)) return `- ${truncateLine(String(value), 120)}`;
  const name = readFirstString(value, nameKeys) ?? 'unknown';
  const details = detailKeys
    .map((key) => {
      const raw = value[key];
      if (typeof raw === 'string' && raw.trim()) return `${key}: ${raw.trim()}`;
      if (typeof raw === 'number' || typeof raw === 'boolean') return `${key}: ${raw}`;
      return undefined;
    })
    .filter(Boolean)
    .slice(0, 3);
  return details.length ? `- ${name} (${details.join(', ')})` : `- ${name}`;
}

function summarizeRecord(title: string, value: unknown): string {
  if (!isRecord(value)) return `${title}: ${String(value)}`;
  const entries = Object.entries(value)
    .filter(([, item]) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')
    .slice(0, 5)
    .map(([key, item]) => `${key}: ${String(item)}`);
  return entries.length ? [title, ...entries].join('\n') : `${title}: complete`;
}

function readFirstString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = readString(record, key);
    if (value) return value;
  }
  return undefined;
}

function readFirstNumber(record: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = readNumber(record, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function readFirstBoolean(record: Record<string, unknown> | undefined, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = readBoolean(record, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function readModelAvailable(record: Record<string, unknown>): boolean | undefined {
  const direct = readBoolean(record, 'available') ?? readBoolean(record, 'ready') ?? readBoolean(record, 'enabled');
  if (direct !== undefined) return direct;
  const status = readFirstString(record, ['status', 'state'])?.toLowerCase();
  if (!status) return undefined;
  if (['available', 'ready', 'ok', 'enabled', 'active'].includes(status)) return true;
  if (['locked', 'disabled', 'missing', 'unavailable', 'unauthorized'].includes(status)) return false;
  return undefined;
}

function readAvailabilityLabel(record: Record<string, unknown>): string | undefined {
  const available = readModelAvailable(record);
  if (available !== undefined) return available ? 'ready' : 'locked';
  return readFirstString(record, ['status', 'state']);
}

function formatDuration(value: number): string {
  const seconds = value > 100000 ? Math.round(value / 1000) : Math.round(value);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

function formatDecimal(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(value);
}

function truncateLine(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}...` : trimmed;
}

function parseJsonParams(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) throw new Error('/rpc params must be a JSON object');
  return parsed;
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2).slice(0, 4000);
  } catch {
    return String(value);
  }
}

function readPath(value: unknown, path: string): unknown {
  if (!path) return value;
  return path.split('.').reduce<unknown>((current, key) => {
    if (!isRecord(current)) return undefined;
    return current[key];
  }, value);
}

function splitFirstWord(value: string): [string, string] {
  const trimmed = value.trim();
  const index = trimmed.search(/\s/);
  if (index < 0) return [trimmed, ''];
  return [trimmed.slice(0, index), trimmed.slice(index + 1)];
}

function tokenizeCommand(value: string): string[] {
  const matches = value.match(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|\S+/g) ?? [];
  return matches.map((item) => item.replace(/^['"]|['"]$/g, ''));
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function dedupeSuggestions(items: SlashCommandSuggestion[]): SlashCommandSuggestion[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.value)) return false;
    seen.add(item.value);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBoolean(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readArray(record: Record<string, unknown> | undefined, key: string): unknown[] | undefined {
  const value = record?.[key];
  return Array.isArray(value) ? value : undefined;
}
