import {
  filterCommandsForDialect,
  speaksHermesRpcDialect,
  homeQuickCommands,
  type GatewayCommand,
} from '@/lib/gateway/dashboard';

/**
 * The Gateway RPC panel offered `tools.list` against a Versutus Gate, which
 * dispatches only registry./providers./environment methods and answered
 * `Unknown method "tools.list"`. Capability flags could not prevent it: the
 * Gate advertises `tools: true` truthfully, because it has tools via backends.
 */
describe('speaksHermesRpcDialect', () => {
  test('hermes and unidentified gateways are treated as Hermes dialect', () => {
    expect(speaksHermesRpcDialect('hermes')).toBe(true);
    expect(speaksHermesRpcDialect('unknown')).toBe(true);
    expect(speaksHermesRpcDialect(undefined)).toBe(true);
  });

  test('a Versutus Gate and OpenClaw do not speak it', () => {
    expect(speaksHermesRpcDialect('custom')).toBe(false);
    expect(speaksHermesRpcDialect('openclaw')).toBe(false);
  });
});

describe('filterCommandsForDialect', () => {
  const commands: GatewayCommand[] = [
    { id: 'tools', label: 'Tools', group: 'Tools', transport: 'rpc', method: 'tools.list', danger: 'safe' },
    { id: 'run', label: 'Run', group: 'Agent', transport: 'agent', agentCommand: 'run', danger: 'safe' },
  ];

  test('a Hermes gateway keeps every command', () => {
    expect(filterCommandsForDialect(commands, 'hermes')).toHaveLength(2);
  });

  test('a Gate drops Hermes-dialect rpc commands but keeps agent ones', () => {
    const filtered = filterCommandsForDialect(commands, 'custom');
    expect(filtered.map((c) => c.id)).toEqual(['run']);
  });

  test('the real quick set loses its rpc husks against a Gate', () => {
    const all = homeQuickCommands();
    const filtered = filterCommandsForDialect(all, 'custom');

    expect(all.some((c) => c.method === 'tools.list')).toBe(true);
    expect(filtered.some((c) => c.method === 'tools.list')).toBe(false);
    expect(filtered.every((c) => c.transport !== 'rpc')).toBe(true);
  });

  test('an unknown kind is left alone rather than stripped', () => {
    expect(filterCommandsForDialect(commands, undefined)).toHaveLength(2);
  });
});
