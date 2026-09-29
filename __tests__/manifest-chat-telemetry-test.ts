import { ManifestClient } from '@/lib/gateway/manifest-client';
import { installStreamingFetch, resetStreamingFetchForTests } from '@/lib/net/streaming-fetch';
import type { GatewayIdentity } from '@/lib/portal/identify';
import type { GatewayProfile } from '@/lib/gateway/types';

const profile: GatewayProfile = {
  id: 'gate', name: 'Gate', url: 'http://gate.test:8760', kind: 'custom', token: 'k', createdAt: 0,
};
const identity: GatewayIdentity = {
  kind: 'custom', kindLabel: 'Gate', auth: { schemes: ['bearer'], requiresToken: true },
  manifest: { endpoints: { chat: '/v1/chat/completions' } },
} as unknown as GatewayIdentity;

afterEach(() => resetStreamingFetchForTests());

test('manifest chat forwards thinking and tool lifecycle frames as they arrive', async () => {
  const frames = [
    { telemetry: { status: 'degraded', message: 'Live thinking and tool activity unavailable for this turn.' } },
    { choices: [{ delta: { reasoning_content: 'first thought' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'Read' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', status: 'running', detail: 'first line' }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', status: 'complete', durationMs: 27 }] } }] },
    { choices: [{ delta: { content: 'Done' } }] },
  ];
  installStreamingFetch((async () => {
    const body = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return { ok: true, status: 200, body } as Response;
  }) as unknown as typeof globalThis.fetch);
  const seen: string[] = [];

  const answer = await new ManifestClient(profile, identity, {}).streamChat(
    [{ role: 'user', content: 'Hi' }],
    (delta) => seen.push(`text:${delta}`),
    {
      model: 'm',
      onReasoning: (delta) => seen.push(`thinking:${delta}`),
      onToolCall: (tool) => seen.push(`tool:${tool.name}:${tool.status}:${tool.id}:${tool.detail ?? ''}`),
      onTelemetryWarning: (warning) => seen.push(`warning:${warning}`),
    },
  );

  expect(answer).toBe('Done');
  expect(seen).toEqual([
    'warning:Live thinking and tool activity unavailable for this turn.',
    'thinking:first thought',
    'tool:Read:running:call-1:',
    'tool:Read:running:call-1:first line',
    'tool:Read:complete:call-1:first line',
    'text:Done',
  ]);
});
