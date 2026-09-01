import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';
import { resolveRoute, METHOD_GUIDANCE } from '@/lib/gateway/rpc-routes';

// Three live-use failures on 2026-08-31, all one class: the app read a response
// shape the Gate does not send. The Gate exposes only /v1/* routes and its
// envelopes are not uniform.

describe('/skills renders the Gate catalogue instead of dumping the envelope', () => {
  // The real payload: GET /v1/skills -> { object: 'list', data: [92] },
  // each entry { name, description, category }.
  const GATE_SHAPE = {
    object: 'list',
    data: [
      { name: 'weather', description: 'Look up the forecast', category: 'Utility' },
      { name: 'github-pr', description: 'Full PR lifecycle', category: 'Dev' },
      { name: 'codemod', description: 'Rewrite call sites', category: 'Dev' },
    ],
  };

  test('a { object, data } catalogue lists skills, never the raw envelope', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue(GATE_SHAPE);
    const result = await executeGatewaySlashCommand('/skills', {
      hello: null, gatewayRequest, runAgentCommand: jest.fn(),
    } as never);
    // The exact symptom on the phone was the envelope printed as a key/value dump.
    expect(result.text).not.toMatch(/^object: list/m);
    expect(result.text).toContain('Skills: 3');
    expect(result.text).toContain('/weather');
    expect(result.text).toContain('Look up the forecast');
  });

  test('skills are grouped under their category headings', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue(GATE_SHAPE);
    const result = await executeGatewaySlashCommand('/skills', {
      hello: null, gatewayRequest, runAgentCommand: jest.fn(),
    } as never);
    expect(result.text).toContain('### Dev (2)');
    expect(result.text).toContain('### Utility (1)');
  });

  test('a large catalogue is capped per category and says how many are hidden', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      name: `skill-${i}`, description: `does thing ${i}`, category: 'Bulk',
    }));
    const gatewayRequest = jest.fn().mockResolvedValue({ object: 'list', data: many });
    const result = await executeGatewaySlashCommand('/skills', {
      hello: null, gatewayRequest, runAgentCommand: jest.fn(),
    } as never);
    expect(result.text).toContain('Skills: 20');
    expect(result.text).toMatch(/16 more in Bulk/);
    expect(result.text).toMatch(/16 not shown/);
  });

  test('the legacy { skills: [...] } shape still renders', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ skills: [{ name: 'legacy', description: 'old shape' }] });
    const result = await executeGatewaySlashCommand('/skills', {
      hello: null, gatewayRequest, runAgentCommand: jest.fn(),
    } as never);
    expect(result.text).toContain('/legacy');
  });

  test('an empty catalogue says so instead of printing an envelope', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ object: 'list', data: [] });
    const result = await executeGatewaySlashCommand('/skills', {
      hello: null, gatewayRequest, runAgentCommand: jest.fn(),
    } as never);
    expect(result.text).toBe('Skills: none reported');
  });
});

describe('environments.list resolves to the route the Gate actually serves', () => {
  test('it has a route, so the sheet is not left with an empty list', () => {
    const route = resolveRoute('environments.list', {});
    expect(route).not.toBeNull();
    expect(route!.route.method).toBe('GET');
    expect(route!.path).toBe('/v1/environments');
  });

  test('it is no longer advertised as having no remote REST', () => {
    // The stale guidance is why every card fell back to NOT_INSTALLED while the
    // Gate reported hermes-local ready with an executable on disk.
    expect(METHOD_GUIDANCE['environments.list']).toBeUndefined();
  });

  test('its host-side siblings keep their guidance', () => {
    expect(METHOD_GUIDANCE['environments.status']).toMatch(/host-side/);
    expect(resolveRoute('environments.status', {})).toBeNull();
  });
});
