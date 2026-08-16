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
  capabilities: ['chat', 'tools'],
};

describe('capabilitiesForBackend', () => {
  it('narrows to the selected backend', () => {
    expect(capabilitiesForBackend([OPENCODE, HERMES], 'hermes-local')).toEqual({
      sessions: false,
      tools: true,
    });
  });

  it('falls back to the union when nothing is selected', () => {
    expect(capabilitiesForBackend([OPENCODE, HERMES], undefined)).toEqual({
      sessions: true,
      tools: true,
    });
  });

  it('falls back to the union when the selection is unknown', () => {
    expect(capabilitiesForBackend([OPENCODE], 'deleted-backend')).toEqual({
      sessions: true,
      tools: true,
    });
  });

  it('reports nothing for a gateway with no backends', () => {
    expect(capabilitiesForBackend([], undefined)).toEqual({ sessions: false, tools: false });
  });
});
