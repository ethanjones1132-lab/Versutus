import { CANCEL_TURN_TIMEOUT_MS, HermesGatewayClient } from '@/lib/gateway/client';
import { ManifestClient } from '@/lib/gateway/manifest-client';
import type { GatewayIdentity } from '@/lib/portal/identify';
import type { GatewayProfile } from '@/lib/gateway/types';

// The turn protocol the Gate answers: the phone names the turn on the request
// (`X-Versutus-Turn-Id`), the Gate names the session the turn landed in on the
// response (`X-Versutus-Session-Id`), and the phone can stop a turn it no
// longer wants through the advertised cancel route. Aborting the local stream
// was the only cancel before, and the host kept working.
const TURN_ID_SHAPE = /^[A-Za-z0-9_-]{8,64}$/;

const HERMES_PROFILE: GatewayProfile = {
  id: 'g1',
  name: 'Test gateway',
  url: 'http://gateway.test:8642',
  kind: 'hermes',
  token: 'k',
  createdAt: 0,
};

const GATE_PROFILE: GatewayProfile = {
  id: 'g2',
  name: 'Test gate',
  url: 'http://gate.test:8760',
  kind: 'custom',
  token: 'k',
  createdAt: 0,
};

function gateIdentity(endpoints: Record<string, string>): GatewayIdentity {
  return {
    kind: 'custom',
    kindLabel: 'Custom — versutus-gate',
    auth: { schemes: ['bearer'], requiresToken: true, grantPath: '/.well-known/gateway/access' },
    manifest: {
      manifest: 'versutus-gateway/v1',
      kind: 'versutus-gate',
      name: 'Test Gate',
      auth: { schemes: ['bearer'], grantPath: '/.well-known/gateway/access' },
      transport: { primary: 'http' },
      endpoints,
      capabilities: { chat: true },
    },
    source: 'manifest',
    identifiedAt: 0,
  };
}

/** A 200 SSE body that ends immediately with the terminal marker. */
function doneStream(headers: Record<string, string> = {}) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    body,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Response;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
});

function chatCall(fetchMock: jest.Mock) {
  return fetchMock.mock.calls.find((call) => String(call[0]).includes('/chat/completions'));
}

/** Headers of the one chat request in the mock's call log. */
function chatHeaders(fetchMock: jest.Mock): Record<string, string> {
  const call = chatCall(fetchMock);
  if (!call) throw new Error('no chat request was sent');
  return (call[1] as RequestInit).headers as Record<string, string>;
}

describe('ManifestClient names the turn it sends', () => {
  test('the chat request carries a protocol-shaped turn id and reports it before the POST', async () => {
    const fetchMock = jest.fn((input: unknown) => {
      if (String(input).includes('/chat/completions')) return Promise.resolve(doneStream());
      return Promise.resolve({ ok: true, status: 200, text: async () => '{}' } as unknown as Response);
    });
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const client = new ManifestClient(
      GATE_PROFILE,
      gateIdentity({ health: '/health', chat: '/v1/chat/completions' }),
      {},
    );
    const announced: string[] = [];
    await client.streamChat([{ role: 'user', content: 'hi' }], () => undefined, {
      model: 'test-model',
      onTurnId: (turnId) => announced.push(turnId),
    });

    const sent = chatHeaders(fetchMock)['X-Versutus-Turn-Id'];
    expect(sent).toMatch(TURN_ID_SHAPE);
    // Announced before the request so a cancel can name a turn whose POST has
    // not even landed yet.
    expect(announced).toEqual([sent]);
  });

  test('two sends get two different turn ids', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) =>
      String(input).includes('/chat/completions')
        ? Promise.resolve(doneStream())
        : Promise.resolve({ ok: true, status: 200, text: async () => '{}' } as unknown as Response),
    );

    const client = new ManifestClient(
      GATE_PROFILE,
      gateIdentity({ health: '/health', chat: '/v1/chat/completions' }),
      {},
    );
    const ids: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      await client.streamChat([{ role: 'user', content: 'hi' }], () => undefined, {
        model: 'm',
        onTurnId: (turnId) => ids.push(turnId),
      });
    }
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  test('a session the Gate adopted is reported, one we already sent is not', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) =>
      String(input).includes('/chat/completions')
        ? Promise.resolve(doneStream({ 'x-versutus-session-id': 's-adopted' }))
        : Promise.resolve({ ok: true, status: 200, text: async () => '{}' } as unknown as Response),
    );

    const client = new ManifestClient(
      GATE_PROFILE,
      gateIdentity({ health: '/health', chat: '/v1/chat/completions' }),
      {},
    );
    const adopted: string[] = [];
    await client.streamChat([{ role: 'user', content: 'hi' }], () => undefined, {
      model: 'm',
      sessionId: 's-known',
      onSession: (id) => adopted.push(id),
    });

    expect(adopted).toEqual(['s-adopted']);

    // The same turn a second time: the header repeats what we sent, which is
    // not news and must not churn the session state.
    adopted.length = 0;
    await client.streamChat([{ role: 'user', content: 'hi' }], () => undefined, {
      model: 'm',
      sessionId: 's-adopted',
      onSession: (id) => adopted.push(id),
    });
    expect(adopted).toEqual([]);
  });
});

describe('ManifestClient.cancelTurn', () => {
  test('POSTs {turnId} to the advertised route and returns when the Gate refuses', async () => {
    const fetchMock = jest.fn((input: unknown, _init?: RequestInit) => {
      if (String(input).includes('/chat/cancel')) {
        return Promise.resolve({ ok: false, status: 500, text: async () => 'boom' } as unknown as Response);
      }
      return Promise.resolve({ ok: true, status: 200, text: async () => '{}' } as unknown as Response);
    });
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const client = new ManifestClient(
      GATE_PROFILE,
      gateIdentity({ health: '/health', chat: '/v1/chat/completions', chatCancel: '/v1/chat/cancel' }),
      {},
    );
    // A refused cancel is swallowed: the user's stream is already gone and a
    // thrown error here would replace that fact with a second, worse one.
    await expect(client.cancelTurn('turn-123')).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('http://gate.test:8760/v1/chat/cancel');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ turnId: 'turn-123' });
  });

  test('is a silent no-op on a gate whose manifest advertises no cancel route', async () => {
    const fetchMock = jest.fn();
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const client = new ManifestClient(
      GATE_PROFILE,
      gateIdentity({ health: '/health', chat: '/v1/chat/completions' }),
      {},
    );
    // An older Gate has no such route; guessing one would 404 a path the
    // manifest never promised.
    await expect(client.cancelTurn('turn-123')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('the cancel request is bounded, so it cannot hold a sheet open', () => {
    // Pinned as a number: the 5s budget is the whole reason a cancel may be
    // fire-and-forget.
    expect(CANCEL_TURN_TIMEOUT_MS).toBe(5_000);
  });
});

describe('HermesGatewayClient turn naming', () => {
  test('announces a turn id but sends no Versutus header to a stock Hermes', async () => {
    const fetchMock = jest.fn(() => Promise.resolve(doneStream()));
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const client = new HermesGatewayClient(HERMES_PROFILE, {});
    const announced: string[] = [];
    await client.streamChat([{ role: 'user', content: 'hi' }], () => undefined, {
      onTurnId: (turnId) => announced.push(turnId),
    });

    // A direct Hermes hosts no turn protocol: the id is a handle the app can
    // cancel against, not something to put on the wire at a host that has
    // never heard of it.
    expect(announced[0]).toMatch(TURN_ID_SHAPE);
    expect(chatHeaders(fetchMock)['X-Versutus-Turn-Id']).toBeUndefined();
  });

  test('adopts a session named on the response, and cancelTurn is a no-op', async () => {
    const fetchMock = jest.fn(() => Promise.resolve(doneStream({ 'x-versutus-session-id': 's-1' })));
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const client = new HermesGatewayClient(HERMES_PROFILE, {});
    const adopted: string[] = [];
    await client.streamChat([{ role: 'user', content: 'hi' }], () => undefined, {
      onSession: (id) => adopted.push(id),
    });
    expect(adopted).toEqual(['s-1']);

    const callsBefore = fetchMock.mock.calls.length;
    await expect(client.cancelTurn('turn-1')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls).toHaveLength(callsBefore);
  });
});
