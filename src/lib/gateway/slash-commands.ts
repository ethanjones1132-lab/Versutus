import {
  GATEWAY_COMMANDS,
  commandAllowed,
  summarizeCommandResult,
  type GatewayCommand,
} from '@/lib/gateway/dashboard';
import {
  diagnosticsReadFromUnknown,
  diagnosticsSlashCopy,
} from '@/lib/gateway/diagnostics-read';
import {
  SESSION_SPEND_LIST_LIMIT,
  sessionSpendCopy,
  sessionSpendReadFromUnknown,
  sessionUsageSpendFromUnknown,
  totalUsage,
} from '@/lib/gateway/session-analytics';
import type { RunOutcome } from '@/lib/gateway/runs';
import {
  pairedDeviceRowCopy,
  pairedDevicesReadFromUnknown,
  type PairedDevice,
} from '@/lib/gateway/paired-devices';
import { matchSkillSlash, type Skill } from '@/lib/gateway/skills';
import { providerUiState } from '@/lib/gateway/provider-state';
import type { ProviderSnapshot } from '@/lib/gateway/provider-types';
import { toolsetsReadFromUnknown } from '@/lib/gateway/toolsets';
import type { ChatMessage, GatewayHelloOk, GatewayMethodAvailability } from '@/lib/gateway/types';
import type { GatewayCapabilityCommand } from '@/lib/portal/manifest';
import { METHOD_GUIDANCE } from '@/lib/gateway/rpc-routes';

const UNSUPPORTED_NOTE = 'Not offered by this gateway';

/** The snapshot's generic reason for a method this gateway does not dispatch (dashboard.ts:1131). */
const GENERIC_NOT_DISPATCHED = 'not dispatched by this gateway';

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
  currentModel?: string;
  gatewayRequest: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
  runAgentCommand: (
    command: string,
    options?: { onDelta?: (delta: string) => void },
  ) => Promise<string>;
  /** Stream agent-command output into the running command bubble. */
  onAgentDelta?: (delta: string) => void;
  /** Agentic run with approval gates (Hermes run API). */
  runTask?: (
    prompt: string,
    onEvent?: (event: { type: string; data?: Record<string, unknown>; timestamp?: number }) => void,
  ) => Promise<RunOutcome>;
  /**
   * Per-request model override on the active gateway profile (Hermes / Gate).
   * Used when the gateway has no remote config REST for `/model set`.
   */
  setModelOverride?: (modelId: string) => void | Promise<void>;
  /**
   * Per-command availability from the capability snapshot. Anything marked
   * `available: false` short-circuits with the snapshot's reason instead of
   * hitting a known-broken endpoint.
   */
  methods?: Record<string, GatewayMethodAvailability>;
  /**
   * Commands contributed by the connected gateway's capability instances
   * (design spec §8). Tried only after every built-in has had its chance,
   * so a gateway can never shadow a first-party command.
   */
  dynamicCommands?: GatewayCapabilityCommand[];
  /**
   * Live transcript, used by `/context` so the command never has to hit a
   * Gate path that does not exist.
   */
  messages?: readonly ChatMessage[];
  /** Clears the thread and opens a fresh session. Used by `/reset`. */
  resetConversation?: () => void | Promise<void>;
  /**
   * Switches the open thread to the given session after `/session restore`
   * read it successfully — the same switch the session selector performs.
   * Absent on hosts that cannot switch; the reply then names what it did
   * not do and points at the session selector.
   */
  restoreSession?: (sessionId: string) => void | Promise<void>;
  /**
   * Opens a fresh session on the host — the same creation the session
   * selector performs, exposed so `/session new` can ask for one from the
   * composer. Absent on hosts that cannot create; the reply then names
   * what it did not do and points at the session selector.
   */
  createNewSession?: (title?: string) => void | Promise<void>;
  /**
   * The app's active Session id, owned by the provider. `/session current`
   * answers from this instead of asking the Gateway for `sessions.current`,
   * which no Gateway dispatches — the Hermes fallback route reads back a
   * `{object:"list",data}` collection that cannot identify the current item.
   * Absent or blank falls through to the remote read, so no active Session
   * still produces the honest no-Session copy.
   */
  currentSessionId?: string;
  /**
   * Skills the app has already fetched. `/help` renders these as slash-command
   * rows. Passed in rather than fetched: the list is already in app state, and
   * awaiting an RPC here put a network round-trip in front of every mistyped
   * command before it could be told it was a typo. Absent or empty simply
   * omits the Skills section.
   */
  skills?: Skill[];
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
  {
    value: '/context',
    label: '/context',
    description: 'Show conversation size',
    danger: 'local',
    family: 'Chat',
    unavailable: false,
  },
  {
    value: '/version',
    label: '/version',
    description: 'Show gateway version',
    danger: 'local',
    family: 'Chat',
    unavailable: false,
  },
  {
    value: '/reset',
    label: '/reset',
    description: 'Clear the conversation and open a new session',
    danger: 'local',
    family: 'Chat',
    unavailable: false,
  },
  {
    value: '/compress',
    label: '/compress',
    description: 'Show conversation size (no compaction over the API)',
    danger: 'local',
    family: 'Chat',
    unavailable: false,
  },
];

export function isSlashCommandInput(text: string): boolean {
  return text.trimStart().startsWith('/');
}

function firstSlashName(slash: string): string {
  return slash.trim().split(/\s+/)[0]?.replace(/^\//, '').toLowerCase() ?? '';
}

const RESERVED_SLASH_NAMES = new Set<string>(
  [
    ...LOCAL_SUGGESTIONS.map((item) => firstSlashName(item.value)),
    ...GATEWAY_COMMANDS.map((command) => (command.slash ? firstSlashName(command.slash) : '')),
  ].filter(Boolean),
);

export function isReservedSlashName(name: string): boolean {
  return RESERVED_SLASH_NAMES.has(name.trim().toLowerCase());
}

/**
 * Hermes skill commands are `/name instruction`. Versutus currently swallows
 * every slash as a client command, so a known skill slash has to skip the
 * executor and go out as a user turn.
 */
export function shouldPassthroughSkillSlash(input: string, skills: Skill[]): boolean {
  const match = matchSkillSlash(input, skills);
  if (!match) return false;
  return !isReservedSlashName(match.skill.name);
}

/**
 * The registry command a recent slash value names, or undefined when none
 * does. Exact slash/alias match wins; otherwise the longest registered slash
 * that is a prefix of the value — so a recent `/device revoke` resolves to
 * the destructive device-revoke entry and never to the shorter `/device` info
 * read that precedes it (commandIdForInput's shortest-token-first quirk).
 * An unresolvable recent keeps its generic row.
 */
function resolveRecentRegistryCommand(value: string): GatewayCommand | undefined {
  const lower = value.trim().toLowerCase();
  let best: GatewayCommand | undefined;
  let bestLength = -1;
  for (const command of GATEWAY_COMMANDS) {
    const slashes: string[] = [command.slash, ...(command.aliases ?? [])].filter(
      (item): item is string => Boolean(item),
    );
    for (const slash of slashes) {
      const candidate = slash.toLowerCase();
      if (lower === candidate || lower.startsWith(`${candidate} `)) {
        if (candidate.length > bestLength) {
          best = command;
          bestLength = candidate.length;
        }
      }
    }
  }
  return best;
}

export function getSlashCommandSuggestions(
  input: string,
  hello: GatewayHelloOk | null,
  recents: string[] = [],
  /**
   * Live per-command availability from the capability snapshot. Without it the
   * registry advertises every command, including the many the gateway does not
   * implement — the user then types commands that can only fail.
   */
  methods: Record<string, GatewayMethodAvailability> = {},
  dynamicCommands: GatewayCapabilityCommand[] = [],
  /**
   * Cap on returned rows. The composer strip wants a short list it can show
   * above the keyboard; the browsable palette passes Infinity because hiding
   * commands is the exact problem it exists to solve.
   */
  limit: number = 12,
  skills: Skill[] = [],
): SlashCommandSuggestion[] {
  const needle = input.trimStart().toLowerCase();

  // Recent commands first — fastest path to what you actually run. A recent
  // that names a registered command carries that entry's danger and the live
  // snapshot's unavailable flag over the generic 'local' row, so a destructive
  // or no-longer-offered recent is not branded as a safe working one; an
  // unresolvable recent keeps the generic row verbatim.
  const recentSuggestions: SlashCommandSuggestion[] = recents
    .filter((item) => item.startsWith('/'))
    .map((value) => {
      const resolved = resolveRecentRegistryCommand(value);
      return {
        value,
        label: value,
        description: 'Recent command',
        danger: resolved?.danger ?? 'local',
        family: 'Recent',
        unavailable: resolved ? methods[resolved.id]?.available === false : false,
      };
    });

  // Show all commands, mark unavailable
  const registrySuggestions = GATEWAY_COMMANDS.map((command) => {
    const advertised = methods[command.id]?.available ?? true;
    const available = command.slash && advertised && commandAllowed(command, hello);
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

  // Instance-contributed commands. A slash already claimed by a built-in is
  // dropped rather than shadowing it — the same precedence the executor uses.
  const builtInSlashes = new Set<string>([
    ...GATEWAY_COMMANDS.map((command) => command.slash).filter(
      (slash): slash is string => Boolean(slash),
    ),
    ...LOCAL_SUGGESTIONS.map((suggestion) => suggestion.value),
  ]);
  const dynamicSuggestions: SlashCommandSuggestion[] = dynamicCommands
    .filter((command) => !builtInSlashes.has(command.slash))
    .map((command) => ({
      value: command.slash,
      label: command.slash,
      description: command.description,
      danger: command.danger,
      family: 'Capability',
      unavailable: false,
    }));

  const skillSuggestions: SlashCommandSuggestion[] = skills
    .map((skill) => ({
      value: `/${skill.name}`,
      label: `/${skill.name}`,
      description: skill.description || 'Skill',
      danger: 'local' as const,
      family: 'Skill',
      unavailable: false,
    }))
    .filter((item) => !builtInSlashes.has(item.value));

  let suggestions = [
    ...recentSuggestions,
    ...localWithMeta,
    ...registrySuggestions,
    ...dynamicSuggestions,
    ...skillSuggestions,
  ];

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

  // When we know live availability, hide host-only / unsupported commands from
  // the palette by default. Typing a prefix that only matches unavailable ones
  // still surfaces them (so power users can discover host-side guidance).
  const hasLiveMethods = Object.keys(methods).length > 0;
  if (hasLiveMethods) {
    const availableOnly = suggestions.filter((item) => !item.unavailable);
    const typedHostOnly =
      needle.length >= 2 && availableOnly.length === 0 && suggestions.some((item) => item.unavailable);
    if (!typedHostOnly) {
      suggestions = availableOnly.length > 0 ? availableOnly : suggestions;
    }
  }

  // Working commands first; any remaining unsupported ones sink to the end.
  suggestions = dedupeSuggestions(suggestions)
    .sort((a, b) => Number(a.unavailable ?? false) - Number(b.unavailable ?? false))
    .slice(0, limit);

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

  if (commandName === '/usage' || commandName === '/cost') {
    return runSessionSpendCommand(commandName, context);
  }

  if (commandName === '/version') {
    return textResult(formatVersionSummary(context.hello), '/version');
  }

  if (commandName === '/context') {
    return textResult(formatContextSummary(context.messages ?? []), '/context');
  }

  if (commandName === '/compress') {
    return textResult(formatCompressSummary(context.messages ?? []), '/compress');
  }

  if (commandName === '/reset') {
    if (!context.resetConversation) {
      return textResult('Cannot reset — no session is available to clear.', '/reset');
    }
    await context.resetConversation();
    return textResult('Conversation cleared. A new session is open.', '/reset');
  }

  // `/env`, `/session current` and bare `/device` answer from local state plus
  // a dispatched read (`environments.list` / `environments.check`, the open
  // Session id, `device.info` with a `device.list` fallback) — never from the
  // registry method the snapshot judged (`environments.status`,
  // `sessions.current`, `device.info`), which no Gateway dispatches. Like the
  // local answers above, they run before the snapshot block. The Session
  // bypass needs the open id in hand: without one there is no local answer,
  // so the block stands and the snapshot reason is kept. A registered
  // `/env <sub>` slash (today `/env list`) keeps today's registry routing;
  // every other sub keeps the family read, so undispatched commands keep
  // blocking with their guidance.
  //
  // `/device repair` answers from `device.list` — the paired-devices registry
  // every Gate dispatches — so it bypasses with bare `/device`: the snapshot
  // judges the undispatched `device.info`/`device.repair` registry methods,
  // never the recovery read. `/device revoke` keeps today's routing through
  // the block into the registry entry, with its danger-destructive
  // confirmation and honest RPC failures.
  //
  // `/model auth` answers from `providers.list` — the provider registry every
  // Gate dispatches (gate/core/providers/rpc.mjs) — rendered through
  // `providerUiState`, the same state the Providers screen badge shows. The
  // snapshot judges the undispatched `models.authStatus` registry method,
  // which no dispatcher serves, so without the bypass the read never runs.
  if (commandName === '/env' && !registeredFamilySubcommand(commandName, args)) {
    return runAdvancedFamilyCommand(commandName, args, context);
  }
  if (commandName === '/session' && context.currentSessionId?.trim() && isLocalSessionRead(args)) {
    return runSessionCommand(args, context);
  }
  if (commandName === '/device' && (args.length === 0 || args[0]?.toLowerCase() === 'repair')) {
    return runApprovalsDevicesCommand(commandName, args, context);
  }
  if (commandName === '/model' && (args[0]?.toLowerCase() === 'auth')) {
    return runModelAuthCommand(context);
  }

  const blocked = blockUnsupportedCommand(commandName, args, context.methods);
  if (blocked) return blocked;

  if (!commandName || commandName === '/help') {
    const sub = args[0]?.toLowerCase();
    if (sub === 'all') return textResult(formatHelp(context.hello, 'all', context.skills ?? [], context.methods), '/help all');
    if (sub === 'admin' || sub === 'write' || sub === 'destructive') return textResult(formatHelp(context.hello, 'admin', context.skills ?? [], context.methods), '/help admin');
    if (sub) return textResult(formatHelp(context.hello, sub, context.skills ?? [], context.methods), `/help ${sub}`);
    return textResult(formatHelp(context.hello, undefined, context.skills ?? [], context.methods), '/help');
  }

  if (commandName === '/rpc') {
    return runRawRpc(argText, context);
  }

  if (commandName === '/run') {
    return runTaskCommand(argText, context);
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
      return directReadResult('logs.tail', `${level} logs`, `/logs ${level}`, result);
    }
    const limit = clampNumber(Number(args[0]), 10, 120, 40);
    return runRegistryCommand('logs', context, { limit, maxBytes: 16000 });
  }

  if (commandName === '/status' || commandName === '/diagnostics') {
    return runHealthChecksCommand(commandName, context);
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
    // Reached only after every built-in dispatch above has declined, so a
    // gateway-advertised slash can never take precedence over a first-party one.
    const dynamic = context.dynamicCommands?.find((entry) => entry.slash === commandName);
    if (dynamic) return runDynamicCommand(dynamic, argText, context);
    return textResult(`Unknown command: ${commandName}\n\n${formatHelp(context.hello, undefined, context.skills ?? [], context.methods)}`, commandName);
  }

  return runCommand(command, context);
}

async function runDynamicCommand(
  command: GatewayCapabilityCommand,
  argText: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  const params: Record<string, unknown> = { ...(command.params ?? {}) };
  const trimmed = argText.trim();
  if (trimmed) params.input = trimmed;

  const result = await context.gatewayRequest(command.method, params);
  return textResult(
    typeof result === 'string' ? result : compactJson(result),
    command.slash,
    typeof result === 'string' ? result : JSON.stringify(result, null, 2),
  );
}

function findCommandBySlash(value: string): GatewayCommand | undefined {
  return GATEWAY_COMMANDS.find((command) => {
    const slashes = [command.slash, ...(command.aliases ?? [])].filter(Boolean).map((item) => item?.toLowerCase());
    return slashes.includes(value.toLowerCase());
  });
}

/**
 * Multiple slashes can map to the same registry id (e.g. `/session get` shares
 * `session-get` with nothing, but `/agents <id>` shares `agents` with `/agents`).
 * Look up the id of the longest slash that is a prefix of the input.
 */
function commandIdForInput(input: string, args: string[]): string | undefined {
  const tokens = [input, ...(input ? [input + ' ' + args.join(' ')] : [])];
  for (const tokensList of tokens) {
    const lower = tokensList.toLowerCase().trim();
    if (!lower) continue;
    const command = GATEWAY_COMMANDS.find((c) => {
      const slashes = [c.slash, ...(c.aliases ?? [])]
        .filter(Boolean)
        .map((s) => (s as string).toLowerCase());
      return slashes.some((slash) => lower === slash || lower.startsWith(`${slash} `));
    });
    if (command) return command.id;
  }
  return undefined;
}

/**
 * The `/session` subs answered from the open Session id rather than a
 * Gateway read. These run before the snapshot block because the block judges
 * the undispatched `sessions.current` registry method, not the local answer.
 */
function isLocalSessionRead(args: string[]): boolean {
  const sub = (args[0] || '').toLowerCase();
  return !sub || sub === 'current' || sub === 'status';
}

/**
 * One line per paired device, reusing the Paired devices pane row copy so the
 * chat path and the pane never describe the same registry differently. An
 * empty registry is an honest empty-ok read — only a failed read may claim
 * failure, and that case never reaches here.
 */
function formatDeviceList(devices: PairedDevice[]): string {
  if (devices.length === 0) return 'No paired devices.';
  const lines = [`Devices: ${devices.length}`];
  for (const device of devices.slice(0, 6)) {
    const row = pairedDeviceRowCopy(device);
    const detail = row.subtitle ? ` (${row.subtitle})` : '';
    const revoked = row.revoked ? ' [revoked]' : '';
    lines.push(`- ${row.title}${detail}${revoked}`);
  }
  return lines.join('\n');
}

function blockUnsupportedCommand(
  commandName: string,
  args: string[],
  methods?: Record<string, GatewayMethodAvailability>,
): SlashCommandResult | null {
  if (!methods || Object.keys(methods).length === 0) return null;
  const id = commandIdForInput(commandName, args);
  if (!id) return null;
  const entry = methods[id];
  if (!entry || entry.available !== false) return null;
  const reason = entry.reason ?? UNSUPPORTED_NOTE;
  const guidance = blockedMethodGuidance(id, reason);
  return textResult(
    guidance
      ? `${commandName} is not available on this gateway. ${guidance} Use /help to see what is.`
      : `${commandName} is not available on this gateway (${reason}). Use /help to see what is.`,
    commandName,
  );
}

/**
 * A blocked command whose snapshot entry carries the generic "not dispatched
 * by this gateway" reason (dashboard.ts:1131) gets the actionable next step
 * METHOD_GUIDANCE already holds for its method (rpc-routes.ts:49-96) — the
 * generic string is a dead end and the guidance was written for exactly these
 * route-less methods. Undefined when no guidance applies, keeping the old reply.
 */
function blockedMethodGuidance(id: string, reason: string | undefined): string | undefined {
  if (reason !== GENERIC_NOT_DISPATCHED) return undefined;
  const command = GATEWAY_COMMANDS.find((c) => c.id === id);
  const method = command?.method;
  return method ? METHOD_GUIDANCE[method] : undefined;
}

async function runTaskCommand(argText: string, context: SlashCommandContext): Promise<SlashCommandResult> {
  const prompt = argText.trim();
  if (!prompt) return textResult('Usage: /run <prompt> — run an agentic task with approval gates', '/run');
  if (!context.runTask) {
    return textResult('This gateway does not support agentic runs (the Hermes run API is required).', '/run');
  }

  const streamed: string[] = [];
  const outcome = await context.runTask(prompt, (event) => {
    const line = formatRunEvent(event);
    if (line) {
      streamed.push(line);
      context.onAgentDelta?.(`${line}\n`);
    }
  });

  if (outcome.cancelled) {
    return textResult('Run cancelled', '/run', `Run ${outcome.runId} was cancelled.`);
  }

  const succeeded = /(complete|succeeded|success|done|finished)/i.test(outcome.status);
  const decision = outcome.approved === undefined ? '' : outcome.approved ? '· approved' : '· denied';
  const body = [
    `Run ${outcome.runId.slice(0, 12)}… ${outcome.status} ${decision}`,
    outcome.error ? `Error: ${outcome.error}` : '',
    outcome.result ? `Result: ${outcome.result}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const summary = outcome.result || outcome.error || outcome.status || 'no result';
  return {
    text: `${succeeded ? 'Run complete' : `Run ${outcome.status}`}: ${summary}`,
    title: '/run',
    raw: [streamed.join('\n'), body].filter(Boolean).join('\n\n'),
  };
}

function formatRunEvent(event: { type: string; data?: Record<string, unknown> }): string {
  if (event.type === 'run.output' || event.type === 'output' || event.type === 'delta') {
    const content = String(event.data?.content ?? event.data?.text ?? '').trim();
    return content;
  }
  if (event.type === 'run.started' || event.type === 'started') {
    return `▶ ${String(event.data?.label ?? 'run started')}`;
  }
  return '';
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
    if (context.currentModel) {
      return textResult(`Active model\nPrimary: ${context.currentModel}\n\nModel catalog: /models`, '/model');
    }
    const snapshot = await readConfigSnapshot(context);
    return textResult(formatModelConfig(snapshot), '/model');
  }

  if (subcommand === 'auth') return runModelAuthCommand(context);

  if (subcommand === 'routing' || subcommand === 'policy') {
    const snapshot = await readConfigSnapshot(context);
    return textResult(formatModelRouting(snapshot), '/model routing', compactJson(readConfigObject(snapshot)));
  }

  if (subcommand === 'agent' || subcommand === 'agents') {
    const snapshot = await readConfigSnapshot(context);
    const agentId = args.slice(1).find((arg) => !arg.startsWith('--'));
    return textResult(formatAgentModels(snapshot, agentId), agentId ? `/model agent ${agentId}` : '/model agents', compactJson(readPath(readConfigObject(snapshot), 'agents')));
  }

  // Bare /model <name> — switch directly through setModelOverride
  // (no --confirm needed; picking a model is not destructive).
  // Fall through to config.patch if no per-request override is available.
  if (subcommand && subcommand !== 'set' && subcommand !== 'auth' && subcommand !== 'routing' && subcommand !== 'policy' && subcommand !== 'agent' && subcommand !== 'agents') {
    const modelId = subcommand;
    const validation = await validateModelId(modelId, context);
    if (context.setModelOverride) {
      await context.setModelOverride(modelId);
      return textResult(
        `Model override set to ${modelId}\nThe current session will reopen so the next turn actually runs on this model.`,
        '/model',
      );
    }
    // Fall through to config.patch path if no setModelOverride
  }

  if (subcommand === 'set') {
    const modelId = args.slice(1).find((arg) => !arg.startsWith('--'));
    if (!modelId) return textResult('Usage: /model set provider/model-id --confirm', '/model set');
    const validation = await validateModelId(modelId, context);
    const confirmed = args.includes('--confirm');
    const force = args.includes('--force');

    // Hermes / Gate: no remote config REST. Prefer the same per-request
    // profile override the model picker uses, instead of config.get/patch.
    if (context.setModelOverride) {
      if (!confirmed) {
        return textResult(
          [
            `Set model override to ${modelId}`,
            validation.state === 'missing'
              ? 'Not found in the live catalog (you can still force it).'
              : `Catalog: ${validation.label}`,
            '',
            `Confirm: /model set ${modelId} --confirm${validation.state === 'missing' ? ' --force' : ''}`,
          ].join('\n'),
          '/model set',
          compactJson(validation.matched ?? validation.catalog),
        );
      }
      if (validation.state === 'missing' && !force) {
        return textResult(
          `Model not found in catalog: ${modelId}\nRun /models or confirm with override:\n/model set ${modelId} --confirm --force`,
          '/model set',
          compactJson(validation.catalog),
        );
      }
      await context.setModelOverride(modelId);
      return textResult(
        `Model override set to ${modelId}.\nThe current session will reopen so the next turn actually runs on this model.`,
        '/model set',
      );
    }

    const snapshot = await readConfigSnapshot(context);
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

  // Bare `/model <name>` — any first token that is not a recognised
    // subcommand is a model id the operator wants to switch to. Picking
    // a model is not destructive; the ceremony around `set --confirm`
    // existed for no gain and is why this composer path is unused in
    // favour of the sheet. Hermes still gets `set --confirm` working
    // unchanged above, so nothing that scripts it breaks.
    const bareModelId = args.find((arg) => !arg.startsWith('--'));
    if (bareModelId) {
      return applyModelIdDirect(bareModelId, context);
    }

    return textResult('Usage: /model, /model auth, /model routing, /model agent <id>, /model set <model-id> --confirm, /model set-agent <agent-id> <model-id> --confirm, or /model fallbacks <ids> --confirm', '/model');
  }

  /**
   * Apply a model id the operator typed without the `set --confirm` ceremony.
   * Hermes / Gate (which exposes `setModelOverride`) goes through the same
   * per-request profile override the picker uses; OpenClaw (no override) goes
   * straight through `config.patch` with the standard primary-model patch.
   */
  async function applyModelIdDirect(modelId: string, context: SlashCommandContext): Promise<SlashCommandResult> {
    if (context.setModelOverride) {
      await context.setModelOverride(modelId);
      return textResult(
        `Model override set to ${modelId}.\nThe current session will reopen so the next turn actually runs on this model.`,
        '/model',
      );
    }

    const snapshot = await readConfigSnapshot(context);
    const baseHash = readBaseHash(snapshot);
    if (!baseHash) return textResult('Could not read the config base hash. Run /model and retry.', '/model');

    const patch = { agents: { defaults: { model: { primary: modelId } } } };
    const result = await context.gatewayRequest('config.patch', {
      raw: JSON.stringify(patch, null, 2),
      baseHash,
    });
    return textResult(`Default model updated to ${modelId}\n${formatConfigWriteResult(result)}`, '/model', compactJson(result));
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
    const result = await context.gatewayRequest('config.diff', {}).catch(e => ({ error: String(e) }));
    return directReadResult('config.diff', 'Config diff', '/config diff', result);
  }

  if (subcommand === 'rollback') {
    const result = await context.gatewayRequest('config.rollback', {}).catch(e => ({ error: String(e) }));
    // 'Config rolled back' is already a past-tense sentence, so the derived
    // `${title} could not be read` reads as nonsense at the exact moment the
    // operator needs to know the rollback did NOT happen.
    return directReadResult('config.rollback', 'Config rolled back', '/config rollback', result, 'Config rollback failed');
  }

  if (subcommand === 'last-good' || subcommand === 'lastgood') {
    const result = await context.gatewayRequest('config.last-good', {}).catch(e => ({ error: String(e) }));
    return directReadResult('config.last-good', 'Last good config', '/config last-good', result);
  }

  // `/config patch {"key":"value"}` is a registered write command
  // (dashboard.ts config-patch, danger write) but runConfigCommand used to
  // swallow it into the path-read fallback below — "Config path not found:
  // patch" — so the write could never happen from chat (and the failure
  // text lied about what the operator asked). Forward it to the registry
  // entry like `/agent status` does: the JSON body rides the RPC params,
  // findConfirmableSlash's danger-write confirmation (already matched on
  // the `/config patch` prefix in the composer) gates it, and a gateway
  // without config REST reports its real RPC error instead of a fake read.
  if (subcommand === 'patch') {
    const json = args.slice(1).join(' ').trim();
    if (!json) return textResult('Usage: /config patch {"key":"value"}', '/config patch');
    let patchParams: Record<string, unknown>;
    try {
      patchParams = parseJsonParams(json);
    } catch {
      return textResult('Config patch expects a JSON object: /config patch {"key":"value"}', '/config patch');
    }
    return runRegistryCommand('config-patch', context, patchParams);
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

async function runHealthChecksCommand(
  commandName: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  const method = commandName === '/status' ? 'status' : 'diagnostics.full';
  try {
    const result = await context.gatewayRequest(method, {});
    return textResult(diagnosticsSlashCopy(diagnosticsReadFromUnknown(result)), commandName);
  } catch {
    return textResult(diagnosticsSlashCopy({ ok: false }), commandName);
  }
}

async function runSessionSpendCommand(
  commandName: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  try {
    const result = await context.gatewayRequest('sessions.list', { limit: SESSION_SPEND_LIST_LIMIT });
    const read = sessionSpendReadFromUnknown(result);
    if (!read.ok) return textResult('Sessions could not be read.', commandName);
    const copy = sessionSpendCopy(totalUsage(read.sessions));
    if (read.sessions.length >= SESSION_SPEND_LIST_LIMIT) {
      return textResult(`${copy}\nNewest ${SESSION_SPEND_LIST_LIMIT} sessions.`, commandName);
    }
    return textResult(copy, commandName);
  } catch {
    return textResult('Sessions could not be read.', commandName);
  }
}

async function runSessionCommand(args: string[], context: SlashCommandContext): Promise<SlashCommandResult> {
  const sub = (args[0] || '').toLowerCase();
  const id = args[1];

  if (!sub || sub === 'current' || sub === 'status') {
    // The app knows which Session is open — the provider owns it. Answer
    // from that instead of asking the Gateway for `sessions.current`, which
    // no Gateway dispatches: the Hermes fallback route reads back a
    // `{object:"list",data}` collection that cannot identify the current
    // item. No active Session falls through to the remote read below, which
    // keeps the honest no-Session copy.
    const localId = context.currentSessionId?.trim() || undefined;
    if (localId) {
      return textResult(`Current session: ${localId}`, '/session current');
    }
    // A bare `catch` here used to swallow the error whole: a rejected read
    // rendered "No current session" -- which may be false, there may well BE
    // one -- with no Raw to diagnose it. Name the failure the way every other
    // session read does, and keep the no-session copy for the case it actually
    // describes: a resolved payload that carries no id.
    const result = await context
      .gatewayRequest('sessions.current', {})
      .catch((e) => ({ error: String(e) }));
    if (isRecord(result) && typeof result.error === 'string') {
      return directReadResult('sessions.current', 'Current session', '/session current', result);
    }
    const current = isRecord(result) ? result : undefined;
    const id = readFirstString(current, ['sessionId', 'id']);
    if (!id) {
      return textResult('No current session or command not supported.', '/session current', compactJson(result));
    }
    const title = readFirstString(current, ['title', 'name']);
    return textResult(
      title ? `Current session: ${id} — ${title}` : `Current session: ${id}`,
      '/session current',
      compactJson(result),
    );
  }

  if (sub === 'list') {
    return runRegistryCommand('sessions', context, { limit: 10 });
  }

  if (sub === 'new') {
    const title = args[1]?.trim() || undefined;
    if (context.createNewSession) {
      await context.createNewSession(title);
      return textResult(
        title ? `New session "${title}" opened — the thread starts fresh` : 'New session opened — the thread starts fresh',
        '/session new',
      );
    }
    return textResult('A new session cannot be opened from here — use the session selector', '/session new');
  }

  if (sub === 'get') {
    if (!id) return textResult('Usage: /session get <session-id>', '/session get');
    const result = await context.gatewayRequest('session.get', { sessionId: id }).catch(e => ({ error: String(e) }));
    return directReadResult('session.get', `Session ${id}`, `/session get ${id}`, result);
  }

  if (sub === 'messages') {
    if (!id) return textResult('Usage: /session messages <session-id>', '/session messages');
    const result = await context.gatewayRequest('session.messages', { sessionId: id, limit: 50 }).catch(e => ({ error: String(e) }));
    return directReadResult('session.messages', `Messages for session ${id}`, `/session messages ${id}`, result);
  }

  if (sub === 'usage') {
    const params = id ? { sessionId: id } : {};
    const result = await context.gatewayRequest('session.usage', params).catch(e => ({ error: String(e) }));
    if (isRecord(result) && typeof result.error === 'string') {
      return directReadResult('session.usage', 'Session usage', '/session usage', result);
    }
    // Both Gate envelopes — bare catalogue totals and one Session's
    // counters — render the spend line `/usage` already prints. The error
    // path above and the unfamiliar-shape fallback below are byte-identical
    // to before, so a rejection and an unknown record read exactly as today.
    const spend = sessionUsageSpendFromUnknown(result);
    if (spend) return textResult(sessionSpendCopy(spend), '/session usage', compactJson(result));
    return directReadResult('session.usage', 'Session usage', '/session usage', result);
  }

  // Dangerous actions - will be intercepted by confirmation in provider if danger=write
  if (sub === 'abort') {
    const params = id ? { sessionId: id } : {};
    const result = await context.gatewayRequest('session.abort', params).catch(e => ({ error: String(e) }));
    return sessionActionResult('abort', result);
  }

  if (sub === 'compact') {
    const params = id ? { sessionId: id } : {};
    const result = await context.gatewayRequest('session.compact', params).catch(e => ({ error: String(e) }));
    return sessionActionResult('compact', result);
  }

  if (sub === 'fork') {
    if (!id) return textResult('Usage: /session fork <session-id>', '/session fork');
    const result = await context.gatewayRequest('session.fork', { sessionId: id }).catch(e => ({ error: String(e) }));
    return sessionActionResult('fork', result);
  }

  if (sub === 'restore') {
    if (!id) return textResult('Usage: /session restore <session-id>', '/session restore');
    const result = await context.gatewayRequest('session.restore', { sessionId: id }).catch(e => ({ error: String(e) }));
    if (isRecord(result) && typeof result.error === 'string') {
      return textResult(`Session ${id} could not be restored: ${result.error}`, `/session restore ${id}`);
    }
    if (context.restoreSession) {
      await context.restoreSession(id);
      return textResult(`Session ${id} restored; the open thread now shows it`, `/session restore ${id}`, compactJson(result));
    }
    return textResult(
      `Session ${id} record read; the open thread is not switched — use the session selector`,
      `/session restore ${id}`,
      compactJson(result),
    );
  }

  return textResult(
    'Usage: /session current | new [title] | list | get <id> | messages <id> | usage [id] | abort [id] | compact [id] | fork <id> | restore <id>',
    '/session'
  );
}

/**
 * A session action whose RPC rejected must carry the failure — with the
 * actionable METHOD_GUIDANCE next step when the error does not already name
 * it — because printing the success copy over a thrown call is how the
 * operator ends up believing a compaction happened. A resolved RPC keeps the
 * success copy, so a gateway that does dispatch `session.compact` or
 * `session.abort` behaves exactly as before.
 */
function sessionActionResult(action: 'abort' | 'compact' | 'fork', result: unknown): SlashCommandResult {
  const title = `/session ${action}`;
  const error = isRecord(result) && typeof result.error === 'string' ? result.error : undefined;
  if (error) {
    const guidance = METHOD_GUIDANCE[`session.${action}`];
    const detail = guidance && !error.includes(guidance) ? `${error} ${guidance}` : error;
    return textResult(`Session ${action} could not be run: ${detail}`, title);
  }
  return textResult(`Session ${action} requested`, title, compactJson(result));
}

/**
 * A direct read/report whose RPC rejected must carry the failure — with
 * the actionable METHOD_GUIDANCE next step when the method has one and
 * the error does not already name it — because printing the success
 * title over a thrown call is how the operator ends up believing the
 * read happened. failurePhrase overrides the derived `${title} could
 * not be read` for actions whose title is already a past-tense sentence
 * ("Device token repair attempted"). A resolved read keeps today's
 * title and Raw.
 */
function directReadResult(
  method: string,
  title: string,
  command: string,
  result: unknown,
  failurePhrase?: string,
): SlashCommandResult {
  const error = isRecord(result) && typeof result.error === 'string' ? result.error : undefined;
  if (error) {
    const guidance = METHOD_GUIDANCE[method];
    const detail = guidance && !error.includes(guidance) ? `${error} ${guidance}` : error;
    return textResult(`${failurePhrase ?? `${title} could not be read`}: ${detail}`, command, compactJson(result));
  }
  return textResult(title, command, compactJson(result));
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
    return formatChannelResult('start', name, result);
  }

  if (sub === 'stop') {
    if (!name) return textResult('Usage: /channel stop <name>', '/channel stop');
    const result = await context.gatewayRequest('channel.stop', { name }).catch(e => ({ error: String(e) }));
    return formatChannelResult('stop', name, result);
  }

  if (sub === 'logout') {
    if (!name) return textResult('Usage: /channel logout <name>', '/channel logout');
    const result = await context.gatewayRequest('channel.logout', { name }).catch(e => ({ error: String(e) }));
    return formatChannelResult('logout', name, result);
  }

  return textResult('Usage: /channel [status] | start <name> | stop <name> | logout <name>', '/channel');
}

function formatChannelResult(action: 'start' | 'stop' | 'logout', name: string, result: unknown): SlashCommandResult {
  if (result && typeof result === 'object' && 'error' in result) {
    const err = String((result as { error: unknown }).error ?? '');
    return textResult(
      `Channel ${name} ${action} failed: ${err}`,
      `/channel ${action} ${name}`,
      compactJson(result),
    );
  }
  const record = result as Record<string, unknown> | null | undefined;
  const status = typeof record?.status === 'string' ? record.status : undefined;
  const state = typeof record?.state === 'string' ? record.state : undefined;
  const verb = action === 'start' ? 'started' : action === 'stop' ? 'stopped' : 'logged out';
  const detail = status ?? state;
  return textResult(
    `Channel ${name} ${verb}${detail ? ` · ${detail}` : ''}`,
    `/channel ${action} ${name}`,
    compactJson(result),
  );
}

async function runApprovalsDevicesCommand(commandName: string, args: string[], context: SlashCommandContext): Promise<SlashCommandResult> {
  if (commandName === '/approvals') {
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'pending') {
      const result = await context.gatewayRequest('approvals.pending', {}).catch(e => ({ error: String(e) }));
      // A rejected read must carry the failure (with the METHOD_GUIDANCE next
      // step when the error does not already name it) — printing the bare
      // title over a thrown call is how the operator believes a pending list
      // was read. A resolved read renders the list into the text.
      const error = isRecord(result) && typeof result.error === 'string' ? result.error : undefined;
      if (error) {
        const guidance = METHOD_GUIDANCE['approvals.pending'];
        const detail = guidance && !error.includes(guidance) ? `${error} ${guidance}` : error;
        return textResult(`Pending approvals could not be read: ${detail}`, '/approvals pending', compactJson(result));
      }
      return textResult(formatApprovalsPending(result), '/approvals pending', compactJson(result));
    }
    return runRegistryCommand('approvals', context);
  }

  if (commandName === '/approval') {
    const action = (args[0] || '').toLowerCase();
    const id = args[1];
    // A blank or unknown action must answer with the usage naming both
    // actions — never interpolate the blank (that rendered a double space
    // and taught nobody approve/deny) and never fall through to the method
    // ternary, which would silently DENY an approval the operator meant
    // something else by.
    if ((action !== 'approve' && action !== 'deny') || !id) {
      return textResult('Usage: /approval approve <id> | deny <id>', '/approval');
    }
    const method = action === 'approve' ? 'approval.approve' : 'approval.deny';
    const result = await context.gatewayRequest(method, { id }).catch(e => ({ error: String(e) }));
    return textResult(`Approval ${action} for ${id}`, `/approval ${action} ${id}`, compactJson(result));
  }

  if (commandName === '/device') {
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'repair') {
      // `device.repair` is dispatched by no Gateway — no Hermes REST
      // (rpc-routes.ts) and no Gate method (only `device.list` is served) —
      // so the call could never succeed. Answer the recovery the operator
      // can actually perform instead: read the paired-devices registry the
      // Gate does serve and render the same state the Paired devices pane
      // shows, with the reconnect next step. A rejected list stays honest
      // through `device.list`, never the repair title.
      const result = await context.gatewayRequest('device.list', {}).catch(e => ({ error: String(e) }));
      const read = pairedDevicesReadFromUnknown(result);
      if (read.ok) {
        return textResult(
          `${formatDeviceList(read.devices)}\n\nReconnect to the gateway to repair the connection — the stored token is reused.`,
          '/device repair',
          compactJson(result),
        );
      }
      return directReadResult('device.list', 'Paired devices', '/device repair', result);
    }
    if (sub === 'revoke') {
      // Forward into the registry entry (dashboard.ts device-revoke, danger
      // destructive) so the confirmation sheet matched by findConfirmableSlash,
      // the snapshot block with guidance, and honest RPC failures all apply
      // instead of the device.info read every other sub falls into.
      return runRegistryCommand('device-revoke', context);
    }
    const result = await context.gatewayRequest('device.info', {}).catch(e => ({ error: String(e) }));
    if (!(isRecord(result) && typeof result.error === 'string')) {
      return directReadResult('device.info', 'Device info', '/device', result);
    }
    // `device.info` is a direct-Hermes-host read. A Gate answers `device.list`
    // instead, so fall back to the registry before reporting the failure. A
    // failed fallback keeps the original `device.info` failure — the first
    // attempt stays the story, exactly as before.
    const fallback = await context.gatewayRequest('device.list', {}).catch(e => ({ error: String(e) }));
    const read = pairedDevicesReadFromUnknown(fallback);
    if (read.ok) {
      return textResult(formatDeviceList(read.devices), '/device', compactJson(fallback));
    }
    return directReadResult('device.info', 'Device info', '/device', result);
  }

  return textResult('Unknown approvals/devices command', commandName);
}

/**
 * Longest registered subcommand slash whose input is the family command plus
 * its args — `/skills status` beats the bare `/skills` entry. The family
 * switch guesses a method from the first argument (`/skills <x>` → `skill.get`),
 * and the guessed method is usually the guidance-only one; the registry
 * command's own method (`skills.status`) is the one with a real route.
 * Bare family names are excluded so `/env` keeps its switch semantics
 * distinct from the registry's `environments.status` entry.
 */
function registeredFamilySubcommand(commandName: string, args: string[]): GatewayCommand | undefined {
  const fullInput = [commandName, ...args].join(' ').toLowerCase().trim();
  if (!fullInput) return undefined;
  let best: GatewayCommand | undefined;
  let bestLength = 0;
  for (const command of GATEWAY_COMMANDS) {
    const slashes = [command.slash, ...(command.aliases ?? [])]
      .filter(Boolean)
      .map((item) => (item as string).toLowerCase().trim());
    for (const slash of slashes) {
      if (slash.length <= commandName.length) continue;
      if (fullInput === slash || fullInput.startsWith(`${slash} `)) {
        if (slash.length > bestLength) {
          best = command;
          bestLength = slash.length;
        }
      }
    }
  }
  return best;
}

async function runAdvancedFamilyCommand(commandName: string, args: string[], context: SlashCommandContext): Promise<SlashCommandResult> {
  const registered = registeredFamilySubcommand(commandName, args);
  if (registered) return runCommand(registered, context);

  const sub = (args[0] || '').toLowerCase();
  if (commandName === '/cron' && sub === 'history') {
    return runCronHistoryCommand(args.slice(1), context);
  }
  if (commandName === '/cron' && (sub === 'run' || sub === 'pause' || sub === 'resume')) {
    return runCronActionCommand(sub, args.slice(1), context);
  }
  if (commandName === '/cron' && sub === 'create') {
    return runCronCreateCommand(args.slice(1).join(' '), context);
  }
  if (commandName === '/env' && (sub === 'start' || sub === 'stop')) {
    return runEnvLifecycleCommand(sub, args.slice(1), context);
  }
  if (commandName === '/skills' && sub) {
    return runSkillDetailCommand(sub, context);
  }
  if (commandName === '/tools' && sub === 'effective') {
    return runToolsEffectiveCommand(context);
  }
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
      method = 'cron.list';
      title = 'Cron';
      break;
    case '/env':
      method = sub ? 'environments.check' : 'environments.list';
      title = 'Environments';
      break;
    case '/skills':
      method = 'skills.list';
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
  return familyCommandResult(commandName, title, method, sub, result);
}

/**
 * Family reads must answer in the bubble text, not only in Raw: a list
 * payload (bare form) renders its formatted rows, and a caught RPC failure
 * carries the error with the METHOD_GUIDANCE next step when one exists —
 * the same honesty rule as sessionActionResult. A resolved single-record
 * read (sub form) keeps the legacy title-as-text shape.
 */
function familyCommandResult(
  commandName: string,
  title: string,
  method: string,
  sub: string,
  result: unknown,
): SlashCommandResult {
  const error = isRecord(result) && typeof result.error === 'string' ? result.error : undefined;
  if (error) {
    const guidance = METHOD_GUIDANCE[method];
    const detail = guidance && !error.includes(guidance) ? `${error} ${guidance}` : error;
    return textResult(`${title} could not be read: ${detail}`, commandName, compactJson(result));
  }
  if (!sub) {
    return textResult(formatFamilyList(commandName, title, result), commandName, compactJson(result));
  }
  if (commandName === '/env') {
    return textResult(formatEnvironmentCheck(result, sub), commandName, compactJson(result));
  }
  return textResult(title, commandName, compactJson(result));
}

function formatFamilyList(commandName: string, title: string, result: unknown): string {
  switch (commandName) {
    case '/tools':
      return formatTools(result);
    case '/skills':
      return formatSkills(result);
    case '/cron':
      return formatCron(result);
    case '/plugins':
      return formatPlugins(result);
    case '/env':
      return formatEnvironments(result);
    case '/agents':
      return formatAgents(result);
    case '/artifacts':
      return formatArtifacts(result);
    default:
      return title;
  }
}

async function runVoiceCommand(commandName: string, args: string[], context: SlashCommandContext): Promise<SlashCommandResult> {
  if (commandName === '/talk') {
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'catalog' || sub === 'config' || sub === 'mode') {
      const result = await context.gatewayRequest(`talk.${sub}`, {}).catch(e => ({ error: String(e) }));
      return directReadResult(`talk.${sub}`, `Talk ${sub}`, `/talk ${sub}`, result);
    }
    return textResult('Usage: /talk catalog | config | mode', '/talk');
  }

  if (commandName === '/voicewake') {
    const result = await context.gatewayRequest('voicewake.status', {}).catch(e => ({ error: String(e) }));
    return directReadResult('voicewake.status', 'VoiceWake status', '/voicewake', result);
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

function formatHelp(
  hello: GatewayHelloOk | null,
  filter?: string,
  skills: Skill[] = [],
  methods: Record<string, GatewayMethodAvailability> = {},
): string {
  const isAdmin = filter === 'admin' || filter === 'write' || filter === 'destructive';
  const familyFilter = filter && !['all', 'admin', 'write', 'destructive'].includes(filter) ? filter : undefined;

  let list = GATEWAY_COMMANDS.filter((command) => command.slash && commandAllowed(command, hello));

  if (familyFilter) {
    list = list.filter((c) => (c as any).group?.toLowerCase?.() === familyFilter || (c as any).family?.toLowerCase?.() === familyFilter);
  }
  if (isAdmin) {
    list = list.filter((c) => c.danger === 'write' || c.danger === 'destructive');
  }

  // The unfiltered view hides rows the capability snapshot marks unavailable —
  // the same predicate the slash palette applies — so help never advertises a
  // command the gateway will answer with "not available on this gateway".
  // /help all, /help admin and /help <family> keep today's rows exactly.
  const hasLiveMethods = Object.keys(methods).length > 0;
  if (filter === undefined && hasLiveMethods) {
    list = list.filter((command) => methods[command.id]?.available !== false);
  }

  // The registry carries a group per command (dashboard.ts:28-45); Discord
  // renders help as structured sections, so emit `### <group>` before each
  // group's rows — groups in registry order, first seen — and MarkdownText
  // draws the heading (parser.ts:187, markdown-text.tsx:60). The rows below
  // stay the same strings the flat wall printed.
  const groupedLines: string[] = [];
  const seenGroups = new Set<GatewayCommand['group']>();
  for (const command of list) {
    if (!seenGroups.has(command.group)) {
      seenGroups.add(command.group);
      groupedLines.push(`### ${command.group}`);
    }
    const danger = command.danger !== 'safe' ? ` [${command.danger}]` : '';
    const scope = command.requiredScope ? ` (${command.requiredScope})` : '';
    groupedLines.push(`${command.slash}${danger}${scope} — ${command.description ?? command.label}`);
  }

  const base = [
    'Available commands',
    '/help — this help',
    '/help all — everything',
    '/help admin — write/destructive only',
    '/help <family> — e.g. sessions, models, config',
    '/rpc <method> [json] — raw escape hatch (advanced)',
    '/context — conversation size',
    '/version — gateway version from the hello handshake',
    '/reset — clear the conversation and open a new session',
  ];

  // Local-only commands (the /model family, /compress) have no registry
  // slash, so the base rows above are their only advertisement. Append the
  // Chat/Models suggestions no base row or listed registry command already
  // covers, deduped by slash, so a new user reading help can see them.
  // Admin and family-filtered views keep today's rows exactly.
  const shownSlashes = new Set<string>(
    [
      ...base
        .map((line) => line.trim().split(/\s+/)[0])
        .filter((token) => token.startsWith('/'))
        .map((token) => token.toLowerCase()),
      ...list
        .flatMap((command) => [command.slash, ...(command.aliases ?? [])])
        .filter((slash): slash is string => Boolean(slash))
        .map((slash) => slash.trim().toLowerCase()),
    ],
  );
  const localRows =
    !isAdmin && !familyFilter
      ? LOCAL_SUGGESTIONS.filter(
          (suggestion) =>
            (suggestion.family === 'Chat' || suggestion.family === 'Models') &&
            !shownSlashes.has(suggestion.label.toLowerCase()),
        ).map((suggestion) => `${suggestion.label} — ${suggestion.description}`)
      : [];

  // Hermes turns every skill into a slash command (agent/skill_commands.py:148),
  // and Versutus already executes and suggests them — but help had no Skills
  // section, so a user who never types `/` cannot learn the skills exist.
  // Append `/name — description` rows to the unfiltered view only; `/help all`,
  // `/help admin` and `/help <family>` keep today's rows exactly.
  const skillRows =
    !isAdmin && !familyFilter && skills.length > 0
      ? skills.map((skill) => `/${skill.name.replace(/^\/+/, '')} — ${skill.description || 'Skill'}`)
      : [];
  const skillSection = skillRows.length > 0 ? ['', 'Skills', ...skillRows] : [];

  if (groupedLines.length === 0 && localRows.length === 0 && skillRows.length === 0) {
    return [...base, '', 'No matching commands for current scope.'].join('\n');
  }

  return [...base, ...localRows, ...skillSection, '', ...groupedLines].join('\n');
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
    case 'bots':
      return formatBots(result);
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

/**
 * `/model auth` reads the provider registry every Gate dispatches
 * (`providers.list` answers `{providers}` of snapshots) and renders one line
 * per provider through `providerUiState` — the same state the Providers
 * screen badge shows (provider-card.tsx). The `model-auth` registry entry
 * (`models.authStatus`) is dispatched by no Gateway, so it is never called
 * here; it stays in the registry so palette availability still judges it.
 * A rejected read names the `providers.list` failure honestly.
 */
async function runModelAuthCommand(context: SlashCommandContext): Promise<SlashCommandResult> {
  const result = await context.gatewayRequest('providers.list', {}).catch(e => ({ error: String(e) }));
  const error = isRecord(result) && typeof result.error === 'string' ? result.error : undefined;
  if (error) {
    return textResult(`Model auth could not be read: ${error}`, '/model auth', compactJson(result));
  }
  return textResult(formatProviderAuth(result), '/model auth', compactJson(result));
}

/**
 * One line per provider: the Providers screen label with its badge state,
 * plus the catalog note the card subtitle shows. Entries that are not shaped
 * like a snapshot fall back to the generic record line rather than crashing.
 */
function formatProviderAuth(result: unknown): string {
  const providers = readCollection(result, ['providers', 'items', 'data']) ?? [];
  if (providers.length === 0) return 'Model auth: none reported';
  const lines = [`Model auth: ${providers.length} provider${providers.length === 1 ? '' : 's'}`];
  for (const item of providers.slice(0, 10)) {
    lines.push(describeProviderAuth(item));
  }
  if (providers.length > 10) lines.push(`...${providers.length - 10} more`);
  return lines.join('\n');
}

function describeProviderAuth(item: unknown): string {
  if (!isRecord(item)) return `- ${truncateLine(String(item), 120)}`;
  let state: string | undefined;
  try {
    state = providerUiState(item as unknown as ProviderSnapshot);
  } catch {
    state = undefined;
  }
  if (!state) return describeNamedRecord(item, ['label', 'name', 'id'], ['status', 'state']);
  const label = readFirstString(item, ['label', 'name', 'id']) ?? 'unknown';
  const id = readFirstString(item, ['id']);
  const name = id && id !== label ? `${label} (${id})` : label;
  const catalog = isRecord(item.catalog) ? item.catalog : undefined;
  const models = catalog && Array.isArray(catalog.models) ? catalog.models : undefined;
  const source = catalog ? readFirstString(catalog, ['source']) : undefined;
  const sourceNote = source === 'live' ? 'live' : source === 'last_known_good' ? 'last known good' : undefined;
  const detail = models && sourceNote
    ? ` (${models.length} model${models.length === 1 ? '' : 's'} · ${sourceNote})`
    : models
      ? ` (${models.length} model${models.length === 1 ? '' : 's'})`
      : '';
  return `- ${name}: ${state}${detail}`;
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

function formatTools(result: unknown): string {
  const read = toolsetsReadFromUnknown(result);
  if (!read.ok) return summarizeRecord('Tools', result);
  if (read.toolsets.length === 0) return 'Tools: none reported';
  const lines = read.toolsets.slice(0, 10).map((toolset) => {
    const description = toolset.description ? `: ${truncateLine(toolset.description, 90)}` : '';
    return `- ${toolset.name}${description}`;
  });
  return [`Toolsets: ${read.toolsets.length}`, ...lines].join('\n');
}

function formatAgents(result: unknown): string {
  const agents = readCollection(result, ['agents', 'items', 'data']);
  if (!agents?.length) return 'Agents: none reported';
  const lines = agents.slice(0, 10).map((item) => describeNamedRecord(item, ['name', 'id', 'agentId', 'label'], ['status', 'state', 'model', 'provider']));
  return [`Agents: ${agents.length}`, ...lines].join('\n');
}

function formatBots(result: unknown): string {
  const bots = readCollection(result, ['data', 'bots', 'items']);
  if (!bots?.length) return 'Bots: none reported';
  const lines = bots.slice(0, 10).map((item) =>
    describeNamedRecord(item, ['displayName', 'name', 'id', 'title'], ['routable', 'routingIssue', 'status', 'state']),
  );
  return [`Bots: ${bots.length}`, ...lines].join('\n');
}

function formatArtifacts(result: unknown): string {
  const artifacts = readCollection(result, ['artifacts', 'items', 'data', 'files']);
  if (!artifacts?.length) return 'Artifacts: none reported';
  const lines = artifacts.slice(0, 10).map((item) => describeNamedRecord(item, ['name', 'id', 'path', 'fileName'], ['size', 'bytes', 'kind', 'updatedAt']));
  return [`Artifacts: ${artifacts.length}`, ...lines].join('\n');
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

function formatApprovalsPending(result: unknown): string {
  const pending = readCollection(result, ['pending', 'requests', 'items']);
  if (!pending?.length) return 'Pending approvals: none reported';
  const lines = pending.slice(0, 10).map((item) =>
    describeNamedRecord(item, ['approvalId', 'id', 'name', 'title'], ['type', 'decision', 'status', 'state']),
  );
  return [`Pending approvals: ${pending.length}`, ...lines].join('\n');
}

function formatMemory(result: unknown): string {
  return formatStatusCollection('Memory', result, ['items', 'checks', 'stores'], ['status', 'state', 'ok', 'healthy']);
}

/**
 * The Gate answers `/v1/skills` with `{ object: 'list', data: [...] }` and 92
 * entries carrying `name`, `description` and `category`. The old reader looked
 * under skills/items/available/installed only -- `data` was missing -- so it
 * found no collection and fell through to `summarizeRecord`, which printed the
 * envelope as `object: list` followed by the raw array. That is the unreadable
 * dump. `formatBots` already had `data` in its key list; this did not.
 *
 * 92 rows will not fit a phone bubble, so group by category and show the first
 * few of each, then say plainly how many were not shown and how to see one.
 */
function formatSkills(result: unknown): string {
  const skills = readCollection(result, ['data', 'skills', 'items', 'available', 'installed']);
  if (!skills) return formatStatusCollection('Skills', result, ['data', 'skills', 'items'], ['status', 'state', 'enabled']);
  if (skills.length === 0) return 'Skills: none reported';

  const byCategory = new Map<string, { name: string; description: string }[]>();
  for (const entry of skills) {
    const record = isRecord(entry) ? entry : {};
    const name = readFirstString(record, ['name', 'id', 'slug', 'title']) ?? '';
    if (!name) continue;
    const category = readFirstString(record, ['category', 'group', 'kind']) ?? 'Other';
    const description = readFirstString(record, ['description', 'summary', 'detail']) ?? '';
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category)!.push({ name, description });
  }
  if (byCategory.size === 0) return `Skills: ${skills.length}`;

  const PER_CATEGORY = 4;
  const lines = [`Skills: ${skills.length} in ${byCategory.size} categor${byCategory.size === 1 ? 'y' : 'ies'}`];
  let hidden = 0;
  for (const [category, entries] of [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push('', `### ${category} (${entries.length})`);
    for (const entry of entries.slice(0, PER_CATEGORY)) {
      const slug = entry.name.replace(/^\/+/, '');
      lines.push(entry.description ? `- /${slug} - ${truncateLine(entry.description, 72)}` : `- /${slug}`);
    }
    if (entries.length > PER_CATEGORY) {
      hidden += entries.length - PER_CATEGORY;
      lines.push(`- ...${entries.length - PER_CATEGORY} more in ${category}`);
    }
  }
  if (hidden > 0) lines.push('', `${hidden} not shown. Type /<skill-name> to run one, or /skills <name> for its detail.`);
  return lines.join('\n');
}

function formatEnvironments(result: unknown): string {
  return formatStatusCollection('Environments', result, ['environments', 'items', 'envs'], ['status', 'state', 'ready', 'healthy']);
}

/**
 * `/env <name>` renders the `environments.check` answer the Environments
 * screen shows for that same environment: the id with its live state, plus
 * the probe's CLI version and protocol exactly as the environment card's
 * subtitle reads them. A resolved read with no state still names the id
 * instead of printing the bare list title; unknown names never reach here
 * (a rejected check names the failure through the error branch above).
 */
function formatEnvironmentCheck(result: unknown, name: string): string {
  const record = isRecord(result) ? result : {};
  const id = readFirstString(record, ['id']) ?? name;
  const state = readFirstString(record, ['state']);
  const probe = isRecord(record.probe) ? record.probe : undefined;
  const cliVersion = readString(probe, 'cliVersion');
  const protocol = readString(probe, 'protocol');
  const detail = [cliVersion, protocol].filter(Boolean).join(' · ');
  const head = state ? `Environment ${id}: ${state}` : `Environment ${id}`;
  return detail ? `${head} · ${detail}` : head;
}

/**
 * `/cron history <job>` reads the per-job run history the Activity run sheet
 * shows. The Gate answers `cron.runs` with an `{object:"list",data}` envelope
 * of runs, so the command renders one text line per run instead of the
 * guidance-only `cron.history` refusal. A rejected read names the failure;
 * a job with no runs says so instead of printing an empty history.
 */
async function runCronHistoryCommand(args: string[], context: SlashCommandContext): Promise<SlashCommandResult> {
  const jobId = (args[0] || '').trim();
  if (!jobId) return textResult('Usage: /cron history <job>', '/cron history');
  const result = await context.gatewayRequest('cron.runs', { jobId }).catch(e => ({ error: String(e) }));
  const error = isRecord(result) && typeof result.error === 'string' ? result.error : undefined;
  if (error) {
    return textResult(`Cron history for ${jobId} could not be read: ${error}`, `/cron history ${jobId}`, compactJson(result));
  }
  const runs = readCollection(result, ['data', 'runs', 'items']) ?? [];
  if (runs.length === 0) {
    return textResult(`No runs recorded for ${jobId}.`, `/cron history ${jobId}`, compactJson(result));
  }
  const lines = [`Cron history for ${jobId}: ${runs.length}`, ...runs.slice(0, 10).map(describeCronRun)];
  return textResult(lines.join('\n'), `/cron history ${jobId}`, compactJson(result));
}

function describeCronRun(value: unknown): string {
  if (!isRecord(value)) return `- ${truncateLine(String(value), 120)}`;
  const name = (typeof value.at === 'string' && value.at.trim())
    ? value.at.trim()
    : (typeof value.id === 'string' ? value.id : 'unknown');
  const status = value.status === 'running' ? 'running' : 'completed';
  const turns = typeof value.turnCount === 'number' ? ` · ${value.turnCount} turns` : '';
  return `- ${truncateLine(name, 120)} · ${status}${turns}`;
}

/**
 * `/cron run|pause|resume <job>` drives the same Run now / Pause / Resume
 * pair the Activity job sheet offers (`botJobs.run`, `botJobs.pause`), over
 * the same `jobs.*` RPCs the Gate dispatches. A rejected action names the
 * failure with the METHOD_GUIDANCE next step when one exists — the same
 * honesty rule as sessionActionResult — so a refused Pause never reads as
 * paused. A missing id answers usage without touching the gateway.
 */
async function runCronActionCommand(
  action: 'run' | 'pause' | 'resume',
  args: string[],
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  const jobId = (args[0] || '').trim();
  if (!jobId) return textResult(`Usage: /cron ${action} <job>`, `/cron ${action}`);
  const method = action === 'run' ? 'jobs.run' : action === 'pause' ? 'jobs.pause' : 'jobs.resume';
  const result = await context.gatewayRequest(method, { jobId }).catch(e => ({ error: String(e) }));
  const error = isRecord(result) && typeof result.error === 'string' ? result.error : undefined;
  if (error) {
    const guidance = METHOD_GUIDANCE[method];
    const detail = guidance && !error.includes(guidance) ? `${error} ${guidance}` : error;
    const verb = action === 'run' ? 'run' : action === 'pause' ? 'paused' : 'resumed';
    return textResult(`Routine ${jobId} could not be ${verb}: ${detail}`, `/cron ${action} ${jobId}`, compactJson(result));
  }
  const done = action === 'run'
    ? `Routine ${jobId} run requested`
    : action === 'pause' ? `Routine ${jobId} paused` : `Routine ${jobId} resumed`;
  return textResult(done, `/cron ${action} ${jobId}`, compactJson(result));
}

/**
 * `/cron create <title> | <schedule> | <prompt>` files a scheduled job
 * through the same `jobs.create` RPC the Activity create form's
 * `botJobs.create` POST resolves to — the Gate dispatches it to the
 * backend's `createJob`, Hermes-kind POSTs the jobs base. A rejected create
 * names the failure with the METHOD_GUIDANCE next step when one exists —
 * the same honesty rule as runCronActionCommand — so a refused create never
 * reads as filed and never clears anything, the slash analog of the form's
 * refusal-keeps-draft. A missing segment answers usage without touching
 * the gateway. Every other `/cron` form keeps its list/runs/actions read
 * untouched.
 */
async function runCronCreateCommand(
  rest: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  const USAGE = 'Usage: /cron create <title> | <schedule> | <prompt>';
  // Split on the first two pipes only: the prompt itself may contain `|`.
  const firstPipe = rest.indexOf('|');
  const secondPipe = firstPipe < 0 ? -1 : rest.indexOf('|', firstPipe + 1);
  const title = firstPipe < 0 ? '' : rest.slice(0, firstPipe).trim();
  const schedule = secondPipe < 0 ? '' : rest.slice(firstPipe + 1, secondPipe).trim();
  const prompt = secondPipe < 0 ? '' : rest.slice(secondPipe + 1).trim();
  if (!title || !schedule || !prompt) return textResult(USAGE, '/cron create');
  const method = 'jobs.create';
  const result = await context
    .gatewayRequest(method, { name: title, schedule, prompt })
    .catch((e) => ({ error: String(e) }));
  const error = isRecord(result) && typeof result.error === 'string' ? result.error : undefined;
  if (error) {
    const guidance = METHOD_GUIDANCE[method];
    const detail = guidance && !error.includes(guidance) ? `${error} ${guidance}` : error;
    return textResult(`Routine ${title} could not be created: ${detail}`, `/cron create ${title}`, compactJson(result));
  }
  return textResult(`Routine ${title} created (${schedule})`, `/cron create ${title}`, compactJson(result));
}

/**
 * `/env start|stop <id>` drives the same Start / Stop pair the Environments
 * section offers (`client.start`, `client.stop`), over the same
 * `environments.lifecycle.*` RPCs the Gate dispatches. A rejected action
 * names the failure with the METHOD_GUIDANCE next step when one exists —
 * the same honesty rule as runCronActionCommand — so a refused Stop never
 * reads as stopped. A missing id answers usage without touching the
 * gateway. Every other `/env` form keeps its check/list read untouched.
 */
async function runEnvLifecycleCommand(
  action: 'start' | 'stop',
  args: string[],
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  const id = (args[0] || '').trim();
  if (!id) return textResult(`Usage: /env ${action} <id>`, `/env ${action}`);
  const method = action === 'start' ? 'environments.lifecycle.start' : 'environments.lifecycle.stop';
  const result = await context.gatewayRequest(method, { id }).catch(e => ({ error: String(e) }));
  const error = isRecord(result) && typeof result.error === 'string' ? result.error : undefined;
  if (error) {
    const guidance = METHOD_GUIDANCE[method];
    const detail = guidance && !error.includes(guidance) ? `${error} ${guidance}` : error;
    const verb = action === 'start' ? 'started' : 'stopped';
    return textResult(`Environment ${id} could not be ${verb}: ${detail}`, `/env ${action} ${id}`, compactJson(result));
  }
  const done = action === 'start' ? `Environment ${id} started` : `Environment ${id} stopped`;
  return textResult(done, `/env ${action} ${id}`, compactJson(result));
}

/**
 * `/skills <name>` answers from the `skills.list` read the Skills pane
 * renders: no Gateway dispatches `skill.get`, so the direct read always
 * answers unknown-method. A name match renders that skill's row; an
 * unknown name says so instead of printing the whole catalogue.
 */
async function runSkillDetailCommand(name: string, context: SlashCommandContext): Promise<SlashCommandResult> {
  const wanted = name.trim().replace(/^\/+/, '').toLowerCase();
  const result = await context.gatewayRequest('skills.list', {}).catch(e => ({ error: String(e) }));
  const error = isRecord(result) && typeof result.error === 'string' ? result.error : undefined;
  if (error) {
    return textResult(`Skill ${name} could not be read: ${error}`, `/skills ${name}`, compactJson(result));
  }
  const skills = readCollection(result, ['data', 'skills', 'items', 'available', 'installed']) ?? [];
  const match = skills.find((entry) => {
    const record = isRecord(entry) ? entry : {};
    const candidate = readFirstString(record, ['name', 'id', 'slug', 'title'])?.replace(/^\/+/, '').toLowerCase();
    return candidate === wanted;
  });
  if (!match) {
    return textResult(`No skill named '${name}'.`, `/skills ${name}`, compactJson(result));
  }
  return textResult(formatSkillDetail(match), `/skills ${name}`, compactJson(result));
}

function formatSkillDetail(value: unknown): string {
  const record = isRecord(value) ? value : {};
  const name = (readFirstString(record, ['name', 'id', 'slug', 'title']) ?? 'unknown').replace(/^\/+/, '');
  const description = readFirstString(record, ['description', 'summary', 'detail']) ?? '';
  const category = readFirstString(record, ['category', 'group', 'kind']);
  const head = description ? `/${name} - ${truncateLine(description, 120)}` : `/${name}`;
  return category ? `${head}\nCategory: ${category}` : head;
}

/**
 * `/tools effective` answers from the `tools.list` read the Tools dashboard
 * entry renders: no Gateway dispatches `tools.effective`, so the direct
 * read always answers unknown-method. The rows are the same `formatTools`
 * rows bare `/tools` renders, via the empty-sub list branch.
 */
async function runToolsEffectiveCommand(context: SlashCommandContext): Promise<SlashCommandResult> {
  const result = await context.gatewayRequest('tools.list', {}).catch(e => ({ error: String(e) }));
  return familyCommandResult('/tools', 'Tools', 'tools.list', '', result);
}

function formatCron(result: unknown): string {
  const record = isRecord(result) ? result : {};
  const running = readFirstBoolean(record, ['running', 'enabled', 'active']);
  const jobs = readCollection(result, ['data', 'jobs', 'crons', 'items']);
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

function formatVersionSummary(hello: GatewayHelloOk | null): string {
  const version = hello?.server?.version?.trim();
  if (!version) return 'Gateway version was not reported in the hello handshake.';
  return `Gateway version: ${version}`;
}

function formatContextSummary(messages: readonly ChatMessage[]): string {
  let user = 0;
  let assistant = 0;
  let system = 0;
  for (const message of messages) {
    if (message.role === 'user') user += 1;
    else if (message.role === 'assistant') assistant += 1;
    else if (message.role === 'system') system += 1;
  }
  return [
    'Conversation',
    `Messages: ${messages.length}`,
    `User: ${user}`,
    `Assistant: ${assistant}`,
    `System: ${system}`,
  ].join('\n');
}

/**
 * Compaction is not offered over the Hermes API server — `session.compact`
 * is guidance-only (rpc-routes.ts:88). Report the conversation size using the
 * same summary shape as `/context`, then name the supported next steps so the
 * operator is never stranded by a command that advertises compaction.
 */
function formatCompressSummary(messages: readonly ChatMessage[]): string {
  return [
    formatContextSummary(messages),
    '',
    'Compaction is not offered over the API.',
    'Start a new session with /reset, or pick a different session from the session selector.',
  ].join('\n');
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
  const models = readModelItems(result);
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
