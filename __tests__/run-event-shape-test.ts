import { HermesGatewayClient } from '@/lib/gateway/client';
import { ManifestClient } from '@/lib/gateway/manifest-client';
import { isRunEventFrame, runNeedsApproval } from '@/lib/gateway/runs';
import { installStreamingFetch, resetStreamingFetchForTests } from '@/lib/net/streaming-fetch';
import type { GatewayIdentity } from '@/lib/portal/identify';
import type { GatewayProfile, RunEvent } from '@/lib/gateway/types';

// A run-event stream is JSON lines over SSE, and `JSON.parse` says yes to a
// great deal that is not a run event: `null`, a number, a string, an array, an
// object with no `type`. One gateway client used to hand every one of those to
// `onEvent` because it only guarded the parse, and the shared reader in runs.ts
// then read `event.type` off a non-event. The two clients must agree on the
// shape they accept, so both gate on `isRunEventFrame` and this suite pins
// that the wire answer cannot drift between them.

const profile: GatewayProfile = {
  id: 'g1',
  name: 'Gate',
  url: 'http://gate.test:8760',
  kind: 'custom',
  token: 'k',
  createdAt: 0,
};

const identity = {
  kind: 'custom',
  kindLabel: 'Gate',
  auth: { schemes: ['bearer'], requiresToken: true },
  manifest: { endpoints: { runs: '/v1/runs' } },
} as unknown as GatewayIdentity;

/** Frames a reader can use: a non-null object carrying a string `type`. */
const WELL_FORMED: RunEvent[] = [
  { type: 'run.started' },
  { type: 'run.delta', data: { text: 'hello' } },
  // An unknown type is still a frame; deciding what it means is runs.ts's job.
  { type: 'some.future.type', data: {} },
];

/** Frames that parse but are not run events. */
const NOT_EVENTS = [
  'null',
  '42',
  '"a string"',
  '[]',
  '[{"type":"run.completed"}]',
  '{}',
  '{"type":42}',
  '{"data":{"type":"run.completed"}}',
  // Not JSON at all: the parse rejects it, which must stay non-fatal too.
  '{not json',
];

function sseBody(extra: string[]): string {
  const lines = [
    ...WELL_FORMED.map((frame) => `data: ${JSON.stringify(frame)}`),
    ...extra.map((frame) => `data: ${frame}`),
  ];
  return `${lines.join('\n\n')}\n\n`;
}

function streamResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
  } as unknown as Response;
}

const clients: [string, () => HermesGatewayClient | ManifestClient][] = [
  ['Hermes', () => new HermesGatewayClient({ ...profile, kind: 'hermes' }, {})],
  ['manifest', () => new ManifestClient(profile, identity, {})],
];

afterEach(() => resetStreamingFetchForTests());

describe('isRunEventFrame', () => {
  test('accepts a non-null object with a string type', () => {
    expect(isRunEventFrame({ type: 'run.started' })).toBe(true);
    expect(isRunEventFrame({ type: 'anything', data: { n: 1 } })).toBe(true);
  });

  test('rejects every parsed shape that is not a run event', () => {
    expect(isRunEventFrame(null)).toBe(false);
    expect(isRunEventFrame(undefined)).toBe(false);
    expect(isRunEventFrame(42)).toBe(false);
    expect(isRunEventFrame('run.started')).toBe(false);
    expect(isRunEventFrame([])).toBe(false);
    expect(isRunEventFrame([{ type: 'run.started' }])).toBe(false);
    expect(isRunEventFrame({})).toBe(false);
    expect(isRunEventFrame({ type: 42 })).toBe(false);
  });
});

describe('runNeedsApproval on malformed input', () => {
  test('a non-string signal asks for nothing instead of throwing', () => {
    // The loose status fallback is fed from event data, which is untyped on
    // the wire. A missing or malformed field must read as "no approval", not
    // crash the stream callback.
    expect(runNeedsApproval(undefined)).toBe(false);
    expect(runNeedsApproval(null)).toBe(false);
    expect(runNeedsApproval(42)).toBe(false);
    expect(runNeedsApproval({ type: 'approval.required' })).toBe(false);
    expect(runNeedsApproval(['approval.required'])).toBe(false);
  });

  test('a string signal keeps today\'s answers', () => {
    expect(runNeedsApproval('approval.required')).toBe(true);
    expect(runNeedsApproval('approved')).toBe(false);
    expect(runNeedsApproval('')).toBe(false);
  });
});

describe.each(clients)('%s run-event stream', (_name, makeClient) => {
  test('delivers exactly the well-formed frames, once each, and drops the rest', async () => {
    installStreamingFetch((async () => streamResponse(sseBody(NOT_EVENTS))) as unknown as typeof globalThis.fetch);

    const seen: RunEvent[] = [];
    await makeClient().streamRunEvents('run-1', (event) => seen.push(event));

    expect(seen).toEqual(WELL_FORMED);
  });

  test('a non-event frame never throws through the stream', async () => {
    installStreamingFetch((async () => streamResponse(sseBody(NOT_EVENTS))) as unknown as typeof globalThis.fetch);

    // The old Hermes path handed `null` and friends to the callback; the
    // reader's `event.type` then threw on a shape. The stream must simply end.
    const seen: unknown[] = [];
    await expect(
      makeClient().streamRunEvents('run-1', (event) => seen.push(event)),
    ).resolves.toBeUndefined();
    expect(seen).toEqual(WELL_FORMED);
  });

  test('an empty stream delivers nothing and does not throw', async () => {
    installStreamingFetch((async () => streamResponse('')) as unknown as typeof globalThis.fetch);

    const seen: RunEvent[] = [];
    await expect(
      makeClient().streamRunEvents('run-1', (event) => seen.push(event)),
    ).resolves.toBeUndefined();
    expect(seen).toEqual([]);
  });
});
