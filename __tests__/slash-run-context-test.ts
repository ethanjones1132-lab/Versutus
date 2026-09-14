import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';

/**
 * `/run`'s capability gate must know the difference between "this gateway
 * does not serve the Hermes run API" and "the run API is real but the
 * gateway is not connected right now". When the capability snapshot marks
 * the run command offline (dashboard.ts writes reason 'offline' for every
 * command while disconnected) and the context carries no runTask, the reply
 * must name the connection, never agentic-run support.
 */
describe('/run capability gate', () => {
  const baseContext = {
    hello: null,
    gatewayRequest: jest.fn(),
    runAgentCommand: jest.fn(),
  };

  test('an offline snapshot without runTask points at the connection, not at run support', async () => {
    const result = await executeGatewaySlashCommand('/run ship the release', {
      ...baseContext,
      // buildCapabilitySnapshot fills EVERY command's method row with this
      // reason while disconnected (dashboard.ts:1136).
      methods: { 'run-task': { available: false, reason: 'offline' } },
    });
    expect(result.text).not.toContain('does not support agentic runs');
    expect(result.text.toLowerCase()).toContain('connect');
  });

  test('still names genuinely missing run support when the gateway is judged reachable', async () => {
    const result = await executeGatewaySlashCommand('/run ship the release', {
      ...baseContext,
      methods: {},
    });
    expect(result.text).toContain('does not support agentic runs');
  });

  test('stays silent when runTask exists — even beside an offline snapshot', async () => {
    const runTask = jest.fn().mockResolvedValue({ runId: 'r1', status: 'completed' });
    const result = await executeGatewaySlashCommand('/run ship the release', {
      ...baseContext,
      runTask,
      methods: { 'run-task': { available: false, reason: 'offline' } },
    });
    // The snapshot block does not run for /run when a real executor is
    // wired: the reply is the run's own outcome, not a block message.
    expect(runTask).toHaveBeenCalled();
    expect(result.text).not.toContain('not connected');
  });
});
