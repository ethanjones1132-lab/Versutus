import { buildCapabilitySnapshot } from '@/lib/gateway/dashboard';
import type { GatewayCapabilities } from '@/lib/gateway/types';

/**
 * What a Versutus Gate reports through ManifestClient.getCapabilities(): short
 * manifest keys plus an endpoint map derived from manifest.endpoints. The
 * Environments and Providers tiles read "Not offered by this gateway" while the
 * Gate serves both, because their group definitions carried no feature or
 * endpoint keys to match on.
 */
const GATE_CAPABILITIES: GatewayCapabilities = {
  object: 'manifest-derived.capabilities',
  platform: 'Versutus Gate',
  model: '',
  auth: { type: 'bearer', required: true },
  runtime: { mode: 'gate', tool_execution: 'remote', split_runtime: false, description: 'Versutus Gate' },
  features: {
    chat: true,
    chat_completions: true,
    chat_completions_streaming: true,
    streaming: true,
    models: true,
    providers: true,
    environments: true,
    capabilityRegistry: true,
  },
  endpoints: {
    health: { method: 'GET', path: '/health' },
    models: { method: 'GET', path: '/v1/models' },
    chat: { method: 'POST', path: '/v1/chat/completions' },
    chat_completions: { method: 'POST', path: '/v1/chat/completions' },
    providers: { method: 'GET', path: '/v1/providers' },
    environments: { method: 'GET', path: '/v1/environments' },
    capabilitiesRpc: { method: 'POST', path: '/v1/capabilities/rpc' },
  },
} as unknown as GatewayCapabilities;

function groupStatus(id: string) {
  const snapshot = buildCapabilitySnapshot('connected', null, [], Date.now(), GATE_CAPABILITIES, []);
  return snapshot.groups.find((group) => group.id === id)?.status;
}

describe('Gate capability tiles', () => {
  it('reports Environments as ready when the Gate serves them', () => {
    expect(groupStatus('environments')).toBe('ready');
  });

  it('reports Providers as ready when the Gate serves them', () => {
    expect(groupStatus('providers')).toBe('ready');
  });

  it('still reports Chat and Models as ready', () => {
    expect(groupStatus('chat')).toBe('ready');
    expect(groupStatus('models')).toBe('ready');
  });

  // Honesty in the other direction matters just as much: the Gate has no
  // sessions, runs, approvals or terminal, and a tile claiming otherwise would
  // offer the user a surface that cannot work.
  it.each(['sessions', 'agent', 'approvals', 'terminal'])('reports %s as unsupported', (id) => {
    expect(groupStatus(id)).toBe('unsupported');
  });
});
