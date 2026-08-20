import { buildCapabilitySnapshot } from '@/lib/gateway/dashboard';
import type { GatewayCapabilities, GatewayHelloOk } from '@/lib/gateway/types';

/**
 * Six groups — channels, plugins, logs, devices, artifacts, nodes — declare no
 * `features` or `endpoints`, so `groupIsAdvertised` can never return true and
 * their only route to ready is a registered capability instance. They were
 * reported as "Not offered by this gateway", which put six capabilities that
 * exist nowhere into the denominator and made the headline permanently
 * understate what the gateway does.
 */

const UNDECLARED = ['channels', 'plugins', 'logs', 'devices', 'artifacts', 'nodes'];

const HELLO = { auth: { scopes: ['operator.read', 'operator.write'] } } as unknown as GatewayHelloOk;

function capabilities(): GatewayCapabilities {
  return {
    object: 'test.capabilities',
    platform: 'test',
    model: '',
    auth: { type: 'bearer', required: true },
    runtime: { mode: 'gate', tool_execution: 'remote', split_runtime: false, description: '' },
    features: { chat: true, chat_completions: true },
    endpoints: { chat: { method: 'POST', path: '/v1/chat/completions' } },
  };
}

function snapshot(instances: { family: string }[] = []) {
  return buildCapabilitySnapshot(
    'connected',
    HELLO,
    undefined,
    Date.now(),
    capabilities(),
    instances as never,
  );
}

describe('undeclared capability groups', () => {
  test('groups nothing can ever advertise are marked undeclared, not unsupported', () => {
    const byId = Object.fromEntries(snapshot().groups.map((g) => [g.id, g]));
    for (const id of UNDECLARED) {
      expect(byId[id]?.status).toBe('undeclared');
      expect(byId[id]?.note).toBe('No gateway defines this yet');
    }
  });

  test('a real capability the gateway lacks stays unsupported', () => {
    // The distinction is the whole point: `skills` exists and this gateway
    // does not offer it; `nodes` exists nowhere.
    const byId = Object.fromEntries(snapshot().groups.map((g) => [g.id, g]));
    expect(byId['skills'].status).toBe('unsupported');
    expect(byId['skills'].note).toBe('Not offered by this gateway');
  });

  test('a registered instance promotes an undeclared group out of limbo', () => {
    // instanceFamilies is the one route these groups have to being real.
    const byId = Object.fromEntries(snapshot([{ family: 'nodes' }]).groups.map((g) => [g.id, g]));
    expect(byId['nodes'].status).not.toBe('undeclared');
  });

  test('the six are the only undeclared ones', () => {
    const undeclared = snapshot().groups.filter((g) => g.status === 'undeclared').map((g) => g.id);
    expect(undeclared.sort()).toEqual([...UNDECLARED].sort());
  });
});
