import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';
import type { GatewayHelloOk } from '@/lib/gateway/types';

const HELLO: GatewayHelloOk = {
  type: 'hello-ok',
  protocol: 3,
  server: { version: '0.5.2', connId: 'c1' },
};

const SKILLS = [
  { name: 'weather', description: 'Look up the forecast' },
  { name: 'github-pr-workflow', description: 'Full PR lifecycle' },
];

function context(overrides: Record<string, unknown> = {}) {
  return {
    hello: HELLO,
    gatewayRequest: jest.fn(),
    runAgentCommand: jest.fn(),
    ...overrides,
  } as any;
}

// These tests previously mocked a `skills.list` RPC, because /help fetched the
// list itself. That put a network round-trip in front of every mistyped command
// before it could be told it was a typo, and the app already held the list in
// state. /help now reads context.skills and makes no wire call at all.
describe('/help advertises the skills the app already fetched', () => {
  test('/help lists each skill slash and its description, with no wire call', async () => {
    const ctx = context({ skills: SKILLS });
    const result = await executeGatewaySlashCommand('/help', ctx);
    expect(result.text).toMatch(/Skills/);
    expect(result.text).toContain('/weather — Look up the forecast');
    expect(result.text).toContain('/github-pr-workflow — Full PR lifecycle');
    expect(ctx.gatewayRequest).not.toHaveBeenCalled();
  });

  test('/help degrades to today output when the app has no skills, and still makes no call', async () => {
    const ctx = context();
    const result = await executeGatewaySlashCommand('/help', ctx);
    expect(result.text).toContain('Available commands');
    expect(result.text).not.toContain('/weather — Look up the forecast');
    expect(ctx.gatewayRequest).not.toHaveBeenCalled();
  });

  test('/help all SHOWS the skills section — it is the everything view', async () => {
    // Changed deliberately. 7153c31 put the local /model rows in /help all
    // "because it IS the everything view"; the skills section disagreed and
    // vanished there. The old assertion also passed vacuously, because it
    // never supplied any skills to hide.
    const result = await executeGatewaySlashCommand('/help all', context({ skills: SKILLS }));
    expect(result.text).toContain('/weather — Look up the forecast');
  });

  test('/help admin does not show the skills section', async () => {
    const result = await executeGatewaySlashCommand('/help admin', context({ skills: SKILLS }));
    expect(result.text).not.toContain('/weather — Look up the forecast');
  });

  test('/help <family> does not show the skills section', async () => {
    const result = await executeGatewaySlashCommand('/help models', context({ skills: SKILLS }));
    expect(result.text).not.toContain('/weather — Look up the forecast');
  });
});
