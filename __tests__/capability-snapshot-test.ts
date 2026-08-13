import {
  buildCapabilitySnapshot,
  filterExecutableCommands,
  homeQuickCommands,
} from '@/lib/gateway/dashboard';
import { getSlashCommandSuggestions } from '@/lib/gateway/slash-commands';
import type { GatewayCapabilities } from '@/lib/gateway/types';

/**
 * Verbatim from hermes-agent 0.18.0 GET /v1/capabilities. If the gateway
 * changes this contract, these tests are the thing that should fail.
 */
const HERMES_CAPABILITIES = {
  object: 'hermes.api_server.capabilities',
  platform: 'hermes-agent',
  model: 'hermes-agent',
  auth: { type: 'bearer', required: true },
  features: {
    chat_completions: true,
    chat_completions_streaming: true,
    responses_api: true,
    responses_streaming: true,
    run_submission: true,
    run_status: true,
    run_events_sse: true,
    run_stop: true,
    run_approval_response: true,
    tool_progress_events: true,
    approval_events: true,
    session_resources: true,
    session_chat: true,
    session_chat_streaming: true,
    session_fork: true,
    admin_config_rw: false,
    jobs_admin: false,
    memory_write_api: false,
    skills_api: true,
    audio_api: false,
    realtime_voice: false,
    cors: false,
  },
  endpoints: {
    health: { method: 'GET', path: '/health' },
    health_detailed: { method: 'GET', path: '/health/detailed' },
    models: { method: 'GET', path: '/v1/models' },
    chat_completions: { method: 'POST', path: '/v1/chat/completions' },
    runs: { method: 'POST', path: '/v1/runs' },
    run_approval: { method: 'POST', path: '/v1/runs/{run_id}/approval' },
    run_stop: { method: 'POST', path: '/v1/runs/{run_id}/stop' },
    skills: { method: 'GET', path: '/v1/skills' },
    toolsets: { method: 'GET', path: '/v1/toolsets' },
    sessions: { method: 'GET', path: '/api/sessions' },
    session_messages: { method: 'GET', path: '/api/sessions/{session_id}/messages' },
  },
} as unknown as GatewayCapabilities;

function groupById(capabilities: GatewayCapabilities | null, id: string) {
  const snapshot = buildCapabilitySnapshot('connected', null, undefined, Date.now(), capabilities);
  const group = snapshot.groups.find((entry) => entry.id === id);
  if (!group) throw new Error(`No capability group "${id}"`);
  return group;
}

describe('capability snapshot against the live Hermes contract', () => {
  test('approvals is ready — the gateway advertises run_approval_response', () => {
    expect(groupById(HERMES_CAPABILITIES, 'approvals').status).toBe('ready');
  });

  test('features the gateway supports are ready', () => {
    for (const id of ['chat', 'agent', 'sessions', 'models', 'skills', 'tools', 'diagnostics']) {
      expect({ id, status: groupById(HERMES_CAPABILITIES, id).status }).toEqual({
        id,
        status: 'ready',
      });
    }
  });

  test('features the gateway explicitly disables are unsupported, not warming', () => {
    for (const id of ['config', 'cron', 'memory', 'voice']) {
      expect({ id, status: groupById(HERMES_CAPABILITIES, id).status }).toEqual({
        id,
        status: 'unsupported',
      });
    }
  });

  test('terminal is unsupported — Hermes advertises no terminal endpoint', () => {
    expect(groupById(HERMES_CAPABILITIES, 'terminal').status).toBe('unsupported');
  });

  test('nothing sits in warming once the gateway has answered', () => {
    const snapshot = buildCapabilitySnapshot(
      'connected',
      null,
      undefined,
      Date.now(),
      HERMES_CAPABILITIES,
    );
    expect(snapshot.groups.filter((group) => group.status === 'warming')).toEqual([]);
    expect(snapshot.status).toBe('fresh');
  });

  test('every group reports offline when disconnected', () => {
    const snapshot = buildCapabilitySnapshot(
      'disconnected',
      null,
      undefined,
      Date.now(),
      HERMES_CAPABILITIES,
    );
    expect(snapshot.status).toBe('offline');
    expect(snapshot.groups.every((group) => group.status === 'unavailable')).toBe(true);
  });

  test('without a catalog groups are unknown rather than falsely ready', () => {
    const snapshot = buildCapabilitySnapshot('connected', null, undefined, Date.now(), null);
    expect(snapshot.groups.every((group) => group.status === 'unknown')).toBe(true);
  });

  test('ready groups report a real command count, not a placeholder', () => {
    const chat = groupById(HERMES_CAPABILITIES, 'chat');
    expect(chat.totalCount).toBeGreaterThan(0);
    expect(chat.availableCount).toBe(chat.totalCount);
  });
});

/**
 * Gate manifests use short keys (`chat`, `models`) rather than Hermes'
 * `chat_completions`. Snapshot matching must accept both or Gate chat
 * looks dead while streamChat works.
 */
const GATE_MANIFEST_CAPABILITIES = {
  object: 'manifest-derived.capabilities',
  platform: 'Custom — versutus-gate',
  features: { chat: true, models: true, streaming: true },
  endpoints: {
    health: { method: 'GET', path: '/health' },
    models: { method: 'GET', path: '/v1/models' },
    chat: { method: 'POST', path: '/v1/chat/completions' },
  },
} as unknown as GatewayCapabilities;

describe('capability snapshot against Gate-style manifests', () => {
  test('chat is ready when the manifest advertises chat (not chat_completions)', () => {
    expect(groupById(GATE_MANIFEST_CAPABILITIES, 'chat').status).toBe('ready');
  });

  test('models is ready from endpoints.models', () => {
    expect(groupById(GATE_MANIFEST_CAPABILITIES, 'models').status).toBe('ready');
  });

  test('runs/sessions stay unsupported on a chat-only gate', () => {
    expect(groupById(GATE_MANIFEST_CAPABILITIES, 'agent').status).toBe('unsupported');
    expect(groupById(GATE_MANIFEST_CAPABILITIES, 'sessions').status).toBe('unsupported');
    expect(groupById(GATE_MANIFEST_CAPABILITIES, 'terminal').status).toBe('unsupported');
  });
});

describe('slash suggestions follow live capability', () => {
  const snapshot = buildCapabilitySnapshot(
    'connected',
    null,
    undefined,
    Date.now(),
    HERMES_CAPABILITIES,
  );

  test('commands the gateway cannot run are hidden unless typed specifically', () => {
    // Bare "/" palette should not advertise host-only /channel noise.
    const open = getSlashCommandSuggestions('/', null, [], snapshot.methods);
    expect(open.every((item) => !item.unavailable || item.family === 'Recent')).toBe(true);

    // Typing a host-only prefix still surfaces guidance-only commands.
    const channelCommands = getSlashCommandSuggestions('/channel', null, [], snapshot.methods).filter(
      (item) => item.value.startsWith('/channel'),
    );
    expect(channelCommands.length).toBeGreaterThan(0);
    expect(channelCommands.every((item) => item.unavailable)).toBe(true);
  });

  test('supported commands stay available', () => {
    const suggestions = getSlashCommandSuggestions('/sessions', null, [], snapshot.methods);
    const sessions = suggestions.find((item) => item.value === '/sessions');
    expect(sessions?.unavailable).toBe(false);
  });

  test('default palette prefers executable commands only', () => {
    const suggestions = getSlashCommandSuggestions('/', null, [], snapshot.methods);
    const firstUnavailable = suggestions.findIndex((item) => item.unavailable);
    // With live methods, unavailable should not appear in the default palette.
    expect(firstUnavailable).toBe(-1);
  });

  test('without a snapshot every command is still offered', () => {
    const suggestions = getSlashCommandSuggestions('/channel', null, []);
    const channelCommands = suggestions.filter((item) => item.value.startsWith('/channel'));
    expect(channelCommands.some((item) => !item.unavailable)).toBe(true);
  });
});

describe('filterExecutableCommands', () => {
  const snapshot = buildCapabilitySnapshot(
    'connected',
    null,
    undefined,
    Date.now(),
    HERMES_CAPABILITIES,
  );

  test('keeps Hermes-ready quick commands and drops host-only ones', () => {
    const filtered = filterExecutableCommands(homeQuickCommands(), snapshot.methods);
    const ids = filtered.map((command) => command.id);
    expect(ids).toEqual(expect.arrayContaining(['health', 'status', 'sessions', 'models', 'tools']));
    expect(ids).not.toContain('channels');
  });

  test('passes the list through when methods map is empty', () => {
    const quick = homeQuickCommands();
    expect(filterExecutableCommands(quick, {})).toEqual(quick);
  });
});

describe('capability instances drive the snapshot', () => {
  const cronInstance = { id: 'standup', kind: 'cron', label: 'Standup', family: 'cron' };
  const providerInstance = { id: 'nvidia', kind: 'provider', label: 'NVIDIA', family: 'models' };

  function snapshotWith(instances: any[]) {
    return buildCapabilitySnapshot('connected', null, undefined, Date.now(), HERMES_CAPABILITIES, instances);
  }

  test('an instance whose family matches a built-in group marks it ready', () => {
    // Hermes advertises jobs_admin: false, so cron is unsupported without instances.
    const without = buildCapabilitySnapshot('connected', null, undefined, Date.now(), HERMES_CAPABILITIES);
    expect(without.groups.find((group) => group.id === 'cron')!.status).toBe('unsupported');

    const withInstance = snapshotWith([cronInstance]);
    expect(withInstance.groups.find((group) => group.id === 'cron')!.status).toBe('ready');
  });

  test('a family matching nothing built-in synthesizes its own group', () => {
    const snapshot = snapshotWith([{ id: 'x', kind: 'weather', label: 'Weather', family: 'weather' }]);
    const group = snapshot.groups.find((entry) => entry.id === 'weather');
    expect(group).toBeDefined();
    expect(group!.status).toBe('ready');
    expect(group!.label).toBe('Weather');
    expect(group!.totalCount).toBe(1);
  });

  test('several instances of one synthesized family are counted together', () => {
    const snapshot = snapshotWith([
      { id: 'a', kind: 'weather', label: 'A', family: 'weather' },
      { id: 'b', kind: 'weather', label: 'B', family: 'weather' },
    ]);
    expect(snapshot.groups.find((entry) => entry.id === 'weather')!.totalCount).toBe(2);
  });

  test('no instances leaves the built-in group list unchanged', () => {
    const withNone = buildCapabilitySnapshot('connected', null, undefined, Date.now(), HERMES_CAPABILITIES);
    const withEmpty = snapshotWith([]);
    expect(withEmpty.groups.map((group) => group.id)).toEqual(withNone.groups.map((group) => group.id));
  });

  test('an instance whose family is already ready does not duplicate the group', () => {
    const snapshot = snapshotWith([providerInstance]);
    const models = snapshot.groups.filter((group) => group.id === 'models');
    expect(models).toHaveLength(1);
    expect(models[0].status).toBe('ready');
  });

  test('instance-driven readiness unlocks that group\'s commands too', () => {
    // Hermes has jobs_admin: false, so Memory-group commands are gated off.
    // A memory-family instance should flip them available.
    const withInstance = snapshotWith([{ id: 'm', kind: 'memory', label: 'M', family: 'memory' }]);
    expect(withInstance.groups.find((group) => group.id === 'memory')!.status).toBe('ready');
  });

  test('a disconnected gateway reports synthesized groups as unavailable, not ready', () => {
    const snapshot = buildCapabilitySnapshot('disconnected', null, undefined, Date.now(), null, [
      { id: 'x', kind: 'weather', label: 'Weather', family: 'weather' },
    ] as any);
    expect(snapshot.groups.find((entry) => entry.id === 'weather')!.status).toBe('unavailable');
  });
});
