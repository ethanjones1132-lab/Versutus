import { capabilitiesForBackend } from '@/lib/gateway/backend-capabilities';
import type { GatewayBackend } from '@/lib/portal/manifest';

function backend(id: string, capabilities: string[]): GatewayBackend {
  return { id, label: id, kind: 'environment', capabilities } as GatewayBackend;
}

/**
 * The Activity screen gates its run UI on the `agent` capability group, which
 * is driven by whether the *selected* backend can run one. The Gate's CLI
 * backends run a turn synchronously and have no run id; Hermes has the full
 * lifecycle. Reporting the union across backends would offer runs on a backend
 * that cannot serve them.
 */
describe('runs capability is scoped to the selected backend', () => {
  const backends = [
    backend('opencode-local', ['sessions', 'tools', 'models']),
    backend('hermes-local', ['sessions', 'tools', 'models', 'runs']),
  ];

  test('a Hermes backend reports runs', () => {
    expect(capabilitiesForBackend(backends, 'hermes-local').runs).toBe(true);
  });

  test('a CLI backend does not', () => {
    expect(capabilitiesForBackend(backends, 'opencode-local').runs).toBe(false);
  });

  test('sessions and tools still resolve alongside runs', () => {
    const caps = capabilitiesForBackend(backends, 'hermes-local');
    expect(caps).toEqual({ sessions: true, tools: true, runs: true });
  });

  test('no selection falls back to the union rather than claiming nothing', () => {
    expect(capabilitiesForBackend(backends, undefined).runs).toBe(true);
  });

  test('an unknown selection also falls back to the union', () => {
    expect(capabilitiesForBackend(backends, 'nope').runs).toBe(true);
  });

  test('no runs-capable backend anywhere reports no runs', () => {
    expect(capabilitiesForBackend([backends[0]], undefined).runs).toBe(false);
  });
});
