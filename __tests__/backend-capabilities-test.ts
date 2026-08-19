import { capabilitiesForBackend } from '@/lib/gateway/backend-capabilities';
import type { GatewayBackend } from '@/lib/portal/manifest';

const OPENCODE: GatewayBackend = {
  id: 'opencode-local',
  label: 'OpenCode',
  kind: 'environment',
  capabilities: ['sessions', 'tools', 'models'],
};
const HERMES: GatewayBackend = {
  id: 'hermes-local',
  label: 'Hermes',
  kind: 'environment',
  // Hermes is the one backend with an agentic run lifecycle.
  capabilities: ['chat', 'tools', 'runs'],
};

describe('capabilitiesForBackend', () => {
  it('narrows to the selected backend', () => {
    expect(capabilitiesForBackend([OPENCODE, HERMES], 'hermes-local')).toEqual({
      sessions: false,
      tools: true,
      runs: true,
    });
  });

  it('falls back to the union when nothing is selected', () => {
    expect(capabilitiesForBackend([OPENCODE, HERMES], undefined)).toEqual({
      sessions: true,
      tools: true,
      runs: true,
    });
  });

  it('falls back to the union when the selection is unknown', () => {
    expect(capabilitiesForBackend([OPENCODE], 'deleted-backend')).toEqual({
      sessions: true,
      tools: true,
      runs: false,
    });
  });

  it('reports nothing for a gateway with no backends', () => {
    expect(capabilitiesForBackend([], undefined)).toEqual({ sessions: false, tools: false, runs: false });
  });
});
