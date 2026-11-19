import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { createNativeServer } from './native-server.mjs';
import { createOpenCodeBackend } from './backends/opencode.mjs';
import { VOICE_POLICY_REFUSAL_CODE } from '../voice/voice-turn-policy.mjs';

export const VOICE_AGENT = 'versutus-call';

const rule = (action, effect, resource = '*') => ({ action, resource, effect });
export const VOICE_RULES = [
  rule('*', 'ask'),
  ...['read', 'glob', 'grep'].map((name) => rule(name, 'allow')),
  // Code Mode has its own fetch; plugins and MCP servers can run code while
  // starting up. Do not make them (or a differently configured agent) available.
  ...['execute', 'subagent', 'skill', 'question'].map((name) => rule(name, 'deny')),
];
const BLOCK_SERVERS = [
  ...['mcp.use', 'plugin.use', 'skill.use'].map((action) => rule(action, 'deny')),
  // Same restrictions in the pre-2.2.3 policy vocabulary.
  ...['mcp:*', 'plugin:*', 'skill:*'].map((resource) => rule('integration.use', 'deny', resource)),
];

export function openCodeVoiceConfig() {
  return {
    default_agent: VOICE_AGENT,
    permissions: VOICE_RULES,
    agents: { [VOICE_AGENT]: { mode: 'primary', permissions: VOICE_RULES } },
    policies: BLOCK_SERVERS,
    snapshots: false,
    formatter: false,
    update: 'disable',
  };
}

async function assertNoManagedConfig() {
  // System policy outranks the voice process's config. Do not launch a
  // process that could start managed MCP/plug-in code before the preflight.
  // https://opencode.ai/docs/config#locations
  const paths = process.platform === 'win32' ? [join(process.env.ProgramData ?? 'C:\\ProgramData', 'opencode')]
    : process.platform === 'darwin' ? [
      '/Library/Application Support/opencode',
      '/Library/Managed Preferences/ai.opencode.managed.plist',
      join('/Library/Managed Preferences', userInfo().username, 'ai.opencode.managed.plist'),
    ] : ['/etc/opencode'];
  for (const path of paths) {
    try { await stat(path); }
    catch (error) { if (error?.code === 'ENOENT') continue; }
    throw Object.assign(new Error('Use typed chat for OpenCode with this PC’s managed settings.'), {
      code: VOICE_POLICY_REFUSAL_CODE,
    });
  }
}

/** Only a Gate-owned server may run the isolated prompt; never attach/fallback. */
export async function runOpenCodeVoice({
  adapter, record, credentials, buildEnvironment, scratchDir, input, sessionId,
  onEvent, serverFactory = createNativeServer, fetchImpl = fetch, checkManaged = assertNoManagedConfig,
}) {
  const { voiceGate, voiceDeviceId, signal } = input;
  await checkManaged();
  signal?.throwIfAborted();
  await mkdir(scratchDir, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(join(scratchDir, 'opencode-'));
  const password = randomBytes(24).toString('hex');
  const localCredentials = { ...credentials, OPENCODE_SERVER_PASSWORD: password };
  let server;
  const feed = new AbortController();
  const abort = () => feed.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const refused = () => Object.assign(new Error('OpenCode could not start a separate permission-checked call.'), {
    code: VOICE_POLICY_REFUSAL_CODE,
  });
  try {
    // Config + SQLite isolation keep typed rules and saved project Allow Always
    // out without editing or opening the user's database.
    // https://opencode.ai/docs/config /docs/permissions /docs/policies
    // https://opencode.ai/docs/cli#paths
    const config = join(scratch, 'opencode.json');
    await writeFile(config, JSON.stringify(openCodeVoiceConfig()), { mode: 0o600 });
    const cwd = record.workspacePolicy?.defaultRoot ?? scratch;
    const localRecord = { ...record, workspacePolicy: { ...record.workspacePolicy, defaultRoot: cwd } };
    server = serverFactory({
      record: localRecord,
      adapter,
      credentials: localCredentials,
      allowAttach: false,
      buildEnvironment: async () => {
        const inherited = await buildEnvironment?.({ record, credentials: localCredentials }) ?? { ...process.env, ...localCredentials };
        const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => (
          !/^(?:OPENCODE_|XDG_|HOME$|USERPROFILE$)/i.test(key)
        )));
        return {
          ...env, HOME: scratch, USERPROFILE: scratch,
          OPENCODE_SERVER_PASSWORD: password, OPENCODE_PASSWORD: password, OPENCODE_CONFIG: config,
          OPENCODE_DISABLE_PROJECT_CONFIG: '1',
          OPENCODE_DB: ':memory:',
          XDG_CONFIG_HOME: scratch, XDG_DATA_HOME: scratch, XDG_CACHE_HOME: scratch, XDG_STATE_HOME: scratch,
        };
      },
    });
    const handle = await server.ensureRunning();
    if (handle.attached || !server.isOwned?.()) throw refused();
    feed.signal.throwIfAborted();
    const backend = createOpenCodeBackend({
      baseUrl: handle.baseUrl, password, directory: cwd, freeOnly: false, fetchImpl,
    });
    await backend.verifyVoicePermissions(VOICE_AGENT, VOICE_RULES, BLOCK_SERVERS);
    const opened = await backend.createSession({ agent: VOICE_AGENT, model: input.model });
    if (!opened.id) throw refused();
    const seen = new Set();
    const subscription = backend.streamEvents(opened.id, (event) => {
      if (event.type !== 'approval.required') { onEvent?.(event); return; }
      const { approvalId, sessionId: owner, action, tool } = event.payload;
      if (owner !== opened.id || !approvalId || seen.has(approvalId) || feed.signal.aborted) return;
      seen.add(approvalId);
      void (async () => {
        const allowed = await voiceGate.approvals.authorize({
          tool: action ?? tool, backendId: record.id, botId: voiceGate.botId, sessionId,
          deviceId: voiceDeviceId, signal: feed.signal,
          announce: (payload) => onEvent?.({ type: 'approval.required', payload }),
        }).catch(() => false);
        if (!feed.signal.aborted) await backend.replyApproval(opened.id, approvalId, allowed ? 'once' : 'reject');
      })().catch(() => feed.abort()); // a failed reply must stop, not retry a grant
    }, feed.signal);
    Promise.resolve(subscription).catch(() => feed.abort());
    try {
      await subscription.ready;
      feed.signal.throwIfAborted();
      return await backend.sendMessage(opened.id, { ...input, agent: VOICE_AGENT, signal: feed.signal });
    } finally {
      feed.abort();
    }
  } finally {
    feed.abort();
    signal?.removeEventListener('abort', abort);
    try { await server?.stop(); }
    finally { await rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(() => {}); }
  }
}
