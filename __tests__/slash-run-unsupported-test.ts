import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';

/**
 * `/run`'s capability gate must also honour the snapshot's `agent` group when
 * the run executor is wired. Every host has a `runTask`, so before this the
 * early `/run` dispatch bypassed the block entirely: a backend the snapshot
 * already judged run-less still received a start request and the provider
 * wrote a durable failed Activity row for it. The fix carries one optional
 * context signal from the provider (`agentRunsStatus`, filled from the same
 * snapshot the Activity screen reads) and refuses only when the connection is
 * up and the group is explicitly `unsupported`. An absent signal, `unknown`
 * and `ready` all keep today's dispatch, and `/workflow` is untouched.
 */
describe('/run refuses a backend the snapshot judged run-less', () => {
  const baseContext = {
    hello: null,
    gatewayRequest: jest.fn(),
    runAgentCommand: jest.fn(),
  };

  const resolvedRun = () =>
    jest.fn().mockResolvedValue({ runId: 'b3f2c9d4e5f6a7b8', status: 'completed', result: 'shipped' });

  test('an unsupported run API refuses before any start request or run row', async () => {
    const runTask = resolvedRun();
    const onAgentDelta = jest.fn();
    const result = await executeGatewaySlashCommand('/run ship the release', {
      ...baseContext,
      runTask,
      onAgentDelta,
      agentRunsStatus: 'unsupported',
    });
    // runTask is what starts the run and creates the Activity row: it must
    // never be reached for a backend that said it cannot serve runs.
    expect(runTask).not.toHaveBeenCalled();
    expect(onAgentDelta).not.toHaveBeenCalled();
    expect(result.runId).toBeUndefined();
    expect(result.text).toContain('does not support agentic runs');
  });

  test('a ready run API still dispatches and carries its run id', async () => {
    const runTask = resolvedRun();
    const result = await executeGatewaySlashCommand('/run ship the release', {
      ...baseContext,
      runTask,
      agentRunsStatus: 'ready',
    });
    expect(runTask).toHaveBeenCalledWith('ship the release', expect.any(Function));
    expect(result.runId).toBe('b3f2c9d4e5f6a7b8');
    expect(result.text).toContain('Run complete');
  });

  test('an unknown run API is not refused on a guess', async () => {
    const runTask = resolvedRun();
    const result = await executeGatewaySlashCommand('/run ship the release', {
      ...baseContext,
      runTask,
      agentRunsStatus: 'unknown',
    });
    expect(runTask).toHaveBeenCalled();
    expect(result.runId).toBe('b3f2c9d4e5f6a7b8');
  });

  test('an absent signal behaves exactly as today', async () => {
    const runTask = resolvedRun();
    const result = await executeGatewaySlashCommand('/run ship the release', {
      ...baseContext,
      runTask,
    });
    expect(runTask).toHaveBeenCalled();
    expect(result.runId).toBe('b3f2c9d4e5f6a7b8');
  });

  test('the offline path still points at the connection, not at run support', async () => {
    // No runTask and the snapshot's offline method row: the reconnect message
    // owns this case, so it must not turn into the unsupported-runs refusal.
    const result = await executeGatewaySlashCommand('/run ship the release', {
      ...baseContext,
      methods: { 'run-task': { available: false, reason: 'offline' } },
    });
    expect(result.text.toLowerCase()).toContain('connect');
    expect(result.text).not.toContain('does not support agentic runs');
  });

  test('a usage miss is still answered before the capability gate', async () => {
    const runTask = resolvedRun();
    const result = await executeGatewaySlashCommand('/run', {
      ...baseContext,
      runTask,
      agentRunsStatus: 'unsupported',
    });
    expect(result.text).toContain('Usage: /run');
    expect(runTask).not.toHaveBeenCalled();
  });

  test('/workflow is untouched by the run signal', async () => {
    const runTask = resolvedRun();
    const result = await executeGatewaySlashCommand('/workflow', {
      ...baseContext,
      runTask,
      agentRunsStatus: 'unsupported',
    });
    expect(result.text).toContain('No workflows yet');
    expect(runTask).not.toHaveBeenCalled();
  });
});

/**
 * Review follow-up (the command-delta buffer shipped with `streamedText` and
 * `commandDelta` declared inside the `try` that the abort branch and the
 * `finally` read: out of scope there, so `tsc` failed and every settled command
 * would have thrown a ReferenceError before `setIsCommandRunning(false)`).
 * The declarations must sit before the `try`.
 */
describe('the command runner declares what its catch and finally read', () => {
  const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
  const nodePath = jest.requireActual('path') as { join(...parts: string[]): string };
  const provider = nodeFs.readFileSync(
    nodePath.join(__dirname, '..', 'src', 'context', 'gateway-provider.tsx'),
    'utf8',
  );

  test('streamedText and commandDelta are declared before the try block that uses them', () => {
    const generation = provider.indexOf('const commandGeneration = clientGenerationRef.current;');
    const tryAt = provider.indexOf('try {', generation);
    const streamed = provider.indexOf("let streamedText = '';", generation);
    const buffer = provider.indexOf('const commandDelta = createCommandDeltaBuffer(', generation);
    expect(generation).toBeGreaterThan(-1);
    expect(streamed).toBeGreaterThan(generation);
    expect(buffer).toBeGreaterThan(generation);
    expect(streamed).toBeLessThan(tryAt);
    expect(buffer).toBeLessThan(tryAt);
  });

  test('the finally and abort branch still read them', () => {
    expect(provider).toMatch(/\} finally \{\n\s*commandDelta\.cancel\(\);/);
    expect(provider).toMatch(/commandDelta\.flush\(\);/);
    expect(provider).toMatch(/!streamedText\.trim\(\)/);
  });
});
