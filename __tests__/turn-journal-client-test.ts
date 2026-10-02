// One turn id per line, and the Gate's journal.
//
// A queued line is parked with a turn id and re-sent under it, so the second
// attempt is a replay of the same turn rather than a second turn doing the work
// again. That only works if the client sends the id the caller names — the old
// streamChat minted a fresh one per call, so every resend was a new turn.

import { HermesGatewayClient } from '@/lib/gateway/client';
import { ManifestClient } from '@/lib/gateway/manifest-client';
import type { GatewayIdentity } from '@/lib/portal/identify';
import type { GatewayProfile } from '@/lib/gateway/types';
import type { TurnMeta } from '@/lib/gateway/turns';

const GATE_PROFILE: GatewayProfile = {
  id: 'g1',
  name: 'Test gate',
  url: 'http://gate.test:8760',
  kind: 'custom',
  token: 'k',
  createdAt: 0,
};

const HERMES_PROFILE: GatewayProfile = {
  id: 'g2',
  name: 'Test hermes',
  url: 'http://hermes.test:8642',
  kind: 'hermes',
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

/** A 200 SSE body the caller wrote frame by frame. */
function sseBody(lines: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(new TextEncoder().encode(`${line}\n\n`));
      }
      controller.close();
    },
  });
}

function streamResponse(lines: string[], headers: Record<string, string> = {}): Response {
  return {
    ok: true,
    status: 200,
    body: sseBody(lines),
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Response;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
});

function urls(fetchMock: jest.Mock): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

/** The headers one recorded fetch call was made with, however the mock was written. */
function requestHeaders(init: unknown): Record<string, string> {
  return ((init as RequestInit | undefined)?.headers ?? {}) as Record<string, string>;
}

describe('streamChat honours a caller-supplied turn id', () => {
  test('the Gate gets the id the caller named, and is told the turn was accepted', async () => {
    const fetchMock = jest.fn((input: unknown, init?: RequestInit) =>
      String(input).includes('/chat/completions')
        ? Promise.resolve(streamResponse(['data: [DONE]']))
        : Promise.resolve({ ok: true, status: 200, text: async () => '{}' } as unknown as Response),
    );
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const client = new ManifestClient(
      GATE_PROFILE,
      gateIdentity({ health: '/health', chat: '/v1/chat/completions' }),
      {},
    );
    const announced: string[] = [];
    const accepted: string[] = [];
    await client.streamChat([{ role: 'user', content: 'hi' }], () => undefined, {
      model: 'm',
      turnId: 'turn-queued-1',
      onTurnId: (id) => announced.push(id),
      onAccepted: (id) => accepted.push(id),
    });

    const chatCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/chat/completions'),
    );
    const headers = requestHeaders(chatCall?.[1]);
    expect(headers['X-Versutus-Turn-Id']).toBe('turn-queued-1');
    // The same id the caller owns, so its Stop can name this turn too.
    expect(announced).toEqual(['turn-queued-1']);
    // Acceptance is the stream starting, which is what releases a queued line.
    expect(accepted).toEqual(['turn-queued-1']);
  });

  test('a send that names no id still gets one, and two such sends differ', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) =>
      String(input).includes('/chat/completions')
        ? Promise.resolve(streamResponse(['data: [DONE]']))
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
        onTurnId: (id) => ids.push(id),
      });
    }
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  test('a refused stream is never an acceptance — the line is still owed', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) =>
      String(input).includes('/chat/completions')
        ? Promise.resolve(
            {
              ok: false,
              status: 502,
              text: async () => '{"error":{"message":"upstream down","code":"backend_error"}}',
              headers: { get: () => null },
            } as unknown as Response,
          )
        : Promise.resolve({ ok: true, status: 200, text: async () => '{}' } as unknown as Response),
    );

    const client = new ManifestClient(
      GATE_PROFILE,
      gateIdentity({ health: '/health', chat: '/v1/chat/completions' }),
      {},
    );
    const accepted: string[] = [];
    await expect(
      client.streamChat([{ role: 'user', content: 'hi' }], () => undefined, {
        model: 'm',
        turnId: 'turn-queued-2',
        onAccepted: (id) => accepted.push(id),
      }),
    ).rejects.toThrow(/upstream down/);
    expect(accepted).toEqual([]);
  });

  test('a direct Hermes names the id it was given too, and still sends no Versutus header', async () => {
    const sent: { url: string; init?: RequestInit }[] = [];
    const fetchMock = jest.fn((input: unknown, init?: RequestInit) => {
      sent.push({ url: String(input), init });
      return Promise.resolve(streamResponse(['data: [DONE]']));
    });
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const client = new HermesGatewayClient(HERMES_PROFILE, {});
    const announced: string[] = [];
    const accepted: string[] = [];
    await client.streamChat([{ role: 'user', content: 'hi' }], () => undefined, {
      turnId: 'turn-hermes-1',
      onTurnId: (id) => announced.push(id),
      onAccepted: (id) => accepted.push(id),
    });

    const headers = requestHeaders(sent[0]?.init);
    expect(announced).toEqual(['turn-hermes-1']);
    expect(accepted).toEqual(['turn-hermes-1']);
    expect(headers['X-Versutus-Turn-Id']).toBeUndefined();
  });
});

describe('a Gate restart arrives as a coded error, not a plain failure', () => {
  test('the terminal frame\'s code rides on the thrown error, with the Gate\'s own words', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) =>
      String(input).includes('/chat/completions')
        ? Promise.resolve(
            streamResponse([
              'id: 7\ndata: {"choices":[{"delta":{"content":"half an ans"}}]}',
              'data: {"error":{"code":"gate_restart","message":"The Gate restarted while this turn was running."}}',
              'data: [DONE]',
            ]),
          )
        : Promise.resolve({ ok: true, status: 200, text: async () => '{}' } as unknown as Response),
    );

    const client = new ManifestClient(
      GATE_PROFILE,
      gateIdentity({ health: '/health', chat: '/v1/chat/completions' }),
      {},
    );
    const deltas: string[] = [];
    const failure = await client
      .streamChat([{ role: 'user', content: 'hi' }], (text) => deltas.push(text), { model: 'm' })
      .then(() => null)
      .catch((error: unknown) => error as Error);

    expect(deltas).toEqual(['half an ans']);
    expect(failure?.message).toBe('The Gate restarted while this turn was running.');
    expect((failure as Error & { code?: string }).code).toBe('gate_restart');
  });
});

describe('the turn journal routes', () => {
  const RUNNING: TurnMeta = { turnId: 't-1', status: 'running', sessionId: 'sess-1' };

  function gateWithJournal(): ManifestClient {
    return new ManifestClient(
      GATE_PROFILE,
      gateIdentity({
        health: '/health',
        chat: '/v1/chat/completions',
        turns: '/v1/turns',
      }),
      {},
    );
  }

  test('a running-turn list asks for this thread and returns what the Gate ran', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ object: 'list', data: [RUNNING] }),
        headers: { get: () => null },
      } as unknown as Response),
    );
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const turns = await gateWithJournal().listTurns({ sessionId: 'sess-1', status: 'running' });

    expect(urls(fetchMock)[0]).toBe('http://gate.test:8760/v1/turns?sessionId=sess-1&status=running');
    expect(turns).toEqual([RUNNING]);
  });

  test('one turn reads as its own record', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ...RUNNING, status: 'done', text: 'The answer is 42.' }),
        headers: { get: () => null },
      } as unknown as Response),
    );
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const turn = await gateWithJournal().getTurn('t-1');

    expect(urls(fetchMock)[0]).toBe('http://gate.test:8760/v1/turns/t-1');
    expect(turn).toMatchObject({ turnId: 't-1', status: 'done', text: 'The answer is 42.' });
  });

  test('a turn this device can no longer read is null, and the journal is still usable', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        text: async () => '{"error":{"code":"unknown_turn","message":"no such turn"}}',
        headers: { get: () => null },
      } as unknown as Response),
    );
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const client = gateWithJournal();
    expect(await client.getTurn('t-gone')).toBeNull();
    // Retention ate one turn; the journal itself is fine.
    expect(client.turnsUnsupported).toBe(false);
  });

  test('a gateway with no journal is asked once, and never again', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        text: async () => '{"error":{"code":"not_found","message":"no /v1/turns here"}}',
        headers: { get: () => null },
      } as unknown as Response),
    );
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const client = gateWithJournal();
    expect(await client.listTurns({ status: 'running' })).toEqual([]);
    expect(client.turnsUnsupported).toBe(true);
    const callsAfterTheRefusal = fetchMock.mock.calls.length;

    expect(await client.listTurns({ status: 'running' })).toEqual([]);
    expect(await client.getTurn('t-1')).toBeNull();
    expect(await client.streamTurnEvents('t-1', { onDelta: () => undefined })).toMatchObject({
      completed: false,
    });
    // Not one extra request after the first refusal.
    expect(fetchMock.mock.calls).toHaveLength(callsAfterTheRefusal);
  });

  test('a journal read that merely failed stays retryable — one failure is not a verdict', async () => {
    let attempt = 0;
    const fetchMock = jest.fn(() => {
      attempt += 1;
      if (attempt === 1) {
        return Promise.resolve({
          ok: false,
          status: 500,
          text: async () => 'boom',
          headers: { get: () => null },
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ object: 'list', data: [RUNNING] }),
        headers: { get: () => null },
      } as unknown as Response);
    });
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const client = gateWithJournal();
    await expect(client.listTurns({ status: 'running' })).rejects.toThrow(/boom/);
    expect(client.turnsUnsupported).toBe(false);
    // A host that was briefly down is asked again — only a 404 is a verdict.
    expect(await client.listTurns({ status: 'running' })).toEqual([RUNNING]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('the event replay reads through the same parser, from the seq it is handed', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve(
        streamResponse([
          'id: 12\ndata: {"choices":[{"delta":{"content":"forty"}}]}',
          'id: 13\ndata: {"choices":[{"delta":{"content":"-two"}}]}',
          'data: [DONE]',
        ]),
      ),
    );
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const deltas: string[] = [];
    const seqs: number[] = [];
    const result = await gateWithJournal().streamTurnEvents('t-1', {
      after: 11,
      onDelta: (text) => deltas.push(text),
      onSeq: (seq) => seqs.push(seq),
    });

    expect(urls(fetchMock)[0]).toBe('http://gate.test:8760/v1/turns/t-1/events?after=11');
    // The replay is read as the chat stream reads it, delta for delta.
    expect(deltas).toEqual(['forty', '-two']);
    // And every frame's seq is reported, which is what a drop resumes after.
    expect(seqs).toEqual([12, 13]);
    expect(result).toMatchObject({ completed: true, lastSeq: 13, error: null });
  });

  test('an event replay that ends in a coded failure keeps the code', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve(
        streamResponse([
          'id: 3\ndata: {"choices":[{"delta":{"content":"half"}}]}',
          'data: {"error":{"code":"gate_restart","message":"The Gate restarted while this turn was running."}}',
          'data: [DONE]',
        ]),
      ),
    );
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const result = await gateWithJournal().streamTurnEvents('t-1', { onDelta: () => undefined });

    expect(result.error).toBe('The Gate restarted while this turn was running.');
    expect(result.errorCode).toBe('gate_restart');
    expect(result.completed).toBe(true);
  });
});