import { createEnvironmentClient } from '@/lib/gateway/environment-client';

type FetchCall = { path: string; init?: RequestInit };

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function harness(responses: Record<string, Response | (() => Response)> = {}) {
  const calls: FetchCall[] = [];
  const fetcher = async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    const match = responses[path];
    if (typeof match === 'function') return match();
    if (match) return match;
    return new Response(JSON.stringify({ runId: 'run-1' }), { status: 200 });
  };
  const client = createEnvironmentClient(async () => ({}) as never, fetcher);
  return { calls, client };
}

describe('CLI runs from the app', () => {
  it('starts a run against the environment run route', async () => {
    const { calls, client } = harness();
    const { runId } = await client.startRun('opencode-local', {
      operation: 'prompt',
      input: { prompt: 'summarise the repo' },
    });
    expect(runId).toBe('run-1');
    expect(calls[0].path).toBe('/v1/environments/opencode-local/runs');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      operation: 'prompt',
      input: { prompt: 'summarise the repo' },
    });
  });

  it('percent-encodes ids so an odd id cannot escape the path', async () => {
    const { calls, client } = harness();
    await client.startRun('a/b', { operation: 'status' });
    expect(calls[0].path).toBe('/v1/environments/a%2Fb/runs');
  });

  it('streams run events as they arrive', async () => {
    const frames = [
      JSON.stringify({ runId: 'run-1', sequence: 1, type: 'run.started', payload: {} }),
      JSON.stringify({ runId: 'run-1', sequence: 2, type: 'output', payload: { text: 'working' } }),
      JSON.stringify({ runId: 'run-1', sequence: 3, type: 'run.completed', payload: {} }),
    ];
    const { calls, client } = harness({
      '/v1/environments/opencode-local/runs/run-1/events': () => sseResponse(frames),
    });

    const seen: string[] = [];
    await client.streamRun('opencode-local', 'run-1', (event) => seen.push(event.type));

    expect(seen).toEqual(['run.started', 'output', 'run.completed']);
    expect(calls[0].path).toBe('/v1/environments/opencode-local/runs/run-1/events');
  });

  it('ignores a malformed frame instead of aborting the stream', async () => {
    const frames = [
      'not json',
      JSON.stringify({ runId: 'run-1', sequence: 1, type: 'output', payload: {} }),
    ];
    const { client } = harness({
      '/v1/environments/e/runs/r/events': () => sseResponse(frames),
    });
    const seen: string[] = [];
    await client.streamRun('e', 'r', (event) => seen.push(event.type));
    expect(seen).toEqual(['output']);
  });

  it('cancels a run', async () => {
    const { calls, client } = harness();
    await client.cancelRun('e', 'r');
    expect(calls[0].path).toBe('/v1/environments/e/runs/r/cancel');
    expect(calls[0].init?.method).toBe('POST');
  });

  it('answers an approval request with the decision', async () => {
    const { calls, client } = harness();
    await client.approveRun('e', 'r', 'approval-9', 'approve');
    expect(calls[0].path).toBe('/v1/environments/e/runs/r/approve');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      approvalId: 'approval-9',
      decision: 'approve',
    });
  });

  it('surfaces a refused run rather than resolving with a bad id', async () => {
    const { client } = harness({
      '/v1/environments/e/runs': () =>
        new Response(JSON.stringify({ error: { message: 'workspace policy violation' } }), { status: 400 }),
    });
    await expect(client.startRun('e', { operation: 'prompt' })).rejects.toThrow(/workspace policy/i);
  });

  it('reports a clear error when the gateway offers no run transport', async () => {
    const client = createEnvironmentClient(async () => ({}) as never);
    await expect(client.startRun('e', { operation: 'prompt' })).rejects.toThrow(/does not support/i);
  });
});
