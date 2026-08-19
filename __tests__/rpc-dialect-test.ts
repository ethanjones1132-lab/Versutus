import {
  buildCapabilitySnapshot,
  filterExecutableCommands,
  homeQuickCommands,
  type GatewayCommand,
} from '@/lib/gateway/dashboard';
import type { GatewayCapabilities, GatewayHelloOk } from '@/lib/gateway/types';

/**
 * The Gateway RPC panel used to offer `tools.list` against a Versutus Gate,
 * which answered `Unknown method "tools.list"`. The stopgap was
 * `filterCommandsForDialect`: drop every rpc command whose gateway kind was
 * not Hermes. That was a static answer to a question only the live gateway can
 * answer — and once the Gate started dispatching these methods, it emptied a
 * tab whose buttons all worked.
 *
 * The replacement is per-method: a command renders iff the connected gateway
 * says it dispatches that method. These tests are the old ones inverted.
 */

const HELLO = { auth: { scopes: ['operator.read', 'operator.write'] } } as unknown as GatewayHelloOk;

function capabilities(overrides: Partial<GatewayCapabilities> = {}): GatewayCapabilities {
  return {
    object: 'test.capabilities',
    platform: 'test',
    model: '',
    auth: { type: 'bearer', required: true },
    runtime: { mode: 'gate', tool_execution: 'remote', split_runtime: false, description: '' },
    features: { tools: true, skills: true },
    endpoints: { toolsets: { method: 'GET', path: '/v1/toolsets' }, skills: { method: 'GET', path: '/v1/skills' } },
    ...overrides,
  };
}

const COMMANDS: GatewayCommand[] = [
  { id: 'tools', label: 'Tools', group: 'Tools', transport: 'rpc', method: 'tools.list', danger: 'safe' },
  { id: 'skills', label: 'Skills', group: 'Skills', transport: 'rpc', method: 'skills.list', danger: 'safe' },
  { id: 'run', label: 'Run', group: 'Agent', transport: 'agent', agentCommand: 'run', danger: 'safe' },
];

function availability(caps: GatewayCapabilities) {
  return buildCapabilitySnapshot('connected', HELLO, COMMANDS, Date.now(), caps).methods;
}

describe('command availability follows the live dispatch table', () => {
  test('a Gate that advertises the method keeps the command', () => {
    const methods = availability(capabilities({ rpcMethods: ['tools.list', 'skills.list'] }));
    expect(methods.tools.available).toBe(true);
    expect(methods.skills.available).toBe(true);
  });

  test('a Gate that does not advertise the method drops it, with a reason', () => {
    const methods = availability(capabilities({ rpcMethods: ['skills.list'] }));
    expect(methods.tools.available).toBe(false);
    expect(methods.tools.reason).toBe('not dispatched by this gateway');
    expect(methods.skills.available).toBe(true);
  });

  test('agent-transport commands are never filtered on the method table', () => {
    // They carry `agentCommand`, not `method`. Keying them off `rpcMethods`
    // would hide both of the registry's agent commands on every gateway — so
    // an empty dispatch table must not affect them. Their own capability still
    // gates them, which is why `runs` is switched on here.
    const methods = availability(capabilities({
      rpcMethods: [],
      features: { runs: true, run_submission: true },
      endpoints: { runs: { method: 'POST', path: '/v1/runs' } },
    }));
    expect(methods.run.available).toBe(true);
  });

  test('an agent command is still gated by its own capability, not the method table', () => {
    const methods = availability(capabilities({ rpcMethods: ['tools.list'] }));
    expect(methods.run.available).toBe(false);
    expect(methods.run.reason).toBe('not offered by this gateway');
  });

  test('a gateway that reports no dispatch table falls back to the Hermes route map', () => {
    // Hermes cannot enumerate its methods, but `rpc-routes.ts` is its table:
    // `tools.list` and `skills.list` both resolve to real Hermes endpoints.
    const methods = availability(capabilities());
    expect(methods.tools.available).toBe(true);
    expect(methods.skills.available).toBe(true);
  });

  test('a method with no Hermes route is dropped even when its group is ready', () => {
    const withUnroutable: GatewayCommand[] = [
      { id: 'nope', label: 'Nope', group: 'Tools', transport: 'rpc', method: 'tools.invent', danger: 'safe' },
    ];
    const methods = buildCapabilitySnapshot('connected', HELLO, withUnroutable, Date.now(), capabilities()).methods;
    expect(methods.nope.available).toBe(false);
    expect(methods.nope.reason).toBe('not dispatched by this gateway');
  });
});

describe('the real quick set on a Gate', () => {
  test('survives now that the Gate dispatches it — the inverse of the old behaviour', () => {
    const all = homeQuickCommands();
    const gateMethods = all.map((command) => command.method).filter((m): m is string => Boolean(m));
    const caps = capabilities({
      rpcMethods: gateMethods,
      features: { tools: true, skills: true, sessions: true, models: true },
      endpoints: {
        toolsets: { method: 'GET', path: '/v1/toolsets' },
        skills: { method: 'GET', path: '/v1/skills' },
        sessions: { method: 'GET', path: '/v1/sessions' },
        models: { method: 'GET', path: '/v1/models' },
        health_detailed: { method: 'GET', path: '/health/detailed' },
      },
    });
    const snapshot = buildCapabilitySnapshot('connected', HELLO, all, Date.now(), caps);
    const kept = filterExecutableCommands(all, snapshot.methods);

    expect(all.some((c) => c.method === 'tools.list')).toBe(true);
    // Previously this was filtered out purely because the gateway was a Gate.
    expect(kept.some((c) => c.method === 'tools.list')).toBe(true);
  });

  test('a Gate advertising nothing renders nothing, without guessing from kind', () => {
    const all = homeQuickCommands();
    const snapshot = buildCapabilitySnapshot('connected', HELLO, all, Date.now(), capabilities({ rpcMethods: [] }));
    expect(filterExecutableCommands(all, snapshot.methods)).toHaveLength(0);
  });
});
