// A turn has to end. `streamChat` used to settle only from a `final`/`error`
// frame, and the `chat.send` RPC's own rejection cannot cover the gap: its
// pending entry was resolved by the acknowledgement, so losing the path between
// the ack and the final left the promise pending for the life of the process —
// composer locked, orb spinning, no error, and an answer the gateway had already
// finished stranded on the other end. The acknowledgement also went out under
// the client's 30s default while the wire was asked for 120s, and the runId the
// handler correlates by was never assigned, so a stopped run's late frames landed
// on the NEXT turn's bubble.

// The adapter remembers the sessions it owns through key-value storage, and
// key-value pulls in AsyncStorage's native module.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('@/lib/gateway/device-auth-token', () => ({
  loadDeviceAuthToken: jest.fn(),
  saveDeviceAuthToken: jest.fn(() => Promise.resolve()),
  clearDeviceAuthToken: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/lib/gateway/device-identity', () => ({
  loadOrCreateDeviceIdentity: jest.fn(() =>
    Promise.resolve({
      deviceId: 'device-1',
      publicKeyB64Url: 'public-key',
      privateKeyB64Url: 'private-key',
      createdAtMs: 0,
    }),
  ),
  signDevicePayload: jest.fn(() => Promise.resolve('signature')),
}));

import { OpenClawGatewayClient } from '@/lib/gateway/openclaw-client';
import { isConnectionError } from '@/lib/gateway/errors';
import { OpenClawAdapterClient } from '@/lib/portal/openclaw-adapter';
import type { GatewayProfile } from '@/lib/gateway/types';

import { loadDeviceAuthToken } from '@/lib/gateway/device-auth-token';

const mockLoadToken = loadDeviceAuthToken as jest.Mock;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {}

  serverOpen() {
    this.onopen?.();
  }

  serverClose(code = 1006, reason = '') {
    this.onclose?.({ code, reason });
  }

  serverFrame(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  frames(method: string): Record<string, unknown>[] {
    return this.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((frame) => frame.method === method);
  }
}

const profile = (extra: Partial<GatewayProfile> = {}): GatewayProfile => ({
  id: 'gw1',
  name: 'OpenClaw gate',
  url: 'ws://gate.test:8642/openclaw',
  kind: 'openclaw',
  bootstrapToken: 'bootstrap-secret',
  createdAt: 0,
  ...extra,
});

const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

/**
 * Virtual time, stepped rather than jumped: the client waits for a socket by
 * re-arming a 100ms timer, so every one of those has to fire, and between them
 * the code under test resumes on a microtask.
 */
async function advanceVirtualTime(totalMs: number) {
  for (let elapsed = 0; elapsed < totalMs; elapsed += 100) {
    jest.advanceTimersByTime(100);
    await flush();
  }
}

function helloOk() {
  return {
    type: 'res',
    id: 'connect',
    ok: true,
    payload: {
      type: 'hello-ok',
      protocol: 4,
      server: { version: '0.9.1' },
      auth: { deviceToken: 'dt-1', role: 'operator', scopes: ['operator.read'] },
    },
  };
}

/** One OpenClaw chat push frame, in the verified dialect's vocabulary. */
const chat = (payload: Record<string, unknown>) => ({ type: 'event', event: 'chat', payload });

/** Connect, complete the handshake, and answer the adapter's own first read. */
async function connected(client: { connect: () => void }): Promise<FakeWebSocket> {
  client.connect();
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  ws.serverOpen();
  ws.serverFrame({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } });
  await flush();
  ws.serverFrame(helloOk());
  await flush();
  const capabilities = ws.frames('capabilities').at(-1);
  if (capabilities) {
    ws.serverFrame({
      type: 'res',
      id: capabilities.id as string,
      ok: true,
      payload: { platform: 'openclaw' },
    });
    await flush();
  }
  return ws;
}

/** Acknowledge the newest `chat.send`, the way the gateway does mid-turn. */
async function ackChatSend(ws: FakeWebSocket, payload: Record<string, unknown> = {}) {
  const frame = ws.frames('chat.send').at(-1);
  expect(frame).toBeDefined();
  ws.serverFrame({ type: 'res', id: frame?.id as string, ok: true, payload });
  await flush();
}

const ask = (text = 'hello') => [{ role: 'user', content: text }];

describe('OpenClawAdapterClient — a turn always settles', () => {
  const realWebSocket = globalThis.WebSocket;
  let randomSpy: jest.SpyInstance<number>;
  let adapter: OpenClawAdapterClient | undefined;

  beforeEach(() => {
    jest.useFakeTimers();
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    FakeWebSocket.instances = [];
    mockLoadToken.mockReset().mockResolvedValue(null);
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    adapter?.disconnect();
    adapter = undefined;
    randomSpy.mockRestore();
    jest.useRealTimers();
    (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  });

  test('losing the connection after the ack settles the turn instead of hanging', async () => {
    adapter = new OpenClawAdapterClient(profile(), {}, { chatStallMs: 1_000 });
    const ws = await connected(adapter);
    const deltas: string[] = [];
    const nudge = jest.spyOn(OpenClawGatewayClient.prototype, 'nudge');
    const turn = adapter.streamChat(ask(), (text) => deltas.push(text));
    await flush();
    await ackChatSend(ws, { runId: 'run-1' });

    // The radio drops between the acknowledgement and the final.
    ws.serverClose(1006);

    await expect(turn).rejects.toThrow('Connection to the gateway was lost during the turn');

    // A frame from the lost run belongs to nobody and must not throw either.
    ws.serverFrame(chat({ runId: 'run-1', state: 'delta', deltaText: 'late' }));
    expect(deltas).toEqual([]);

    // The stall timer did not outlive the turn it was watching.
    jest.advanceTimersByTime(5_000);
    await flush();
    expect(ws.frames('session.abort')).toHaveLength(0);
    expect(nudge).not.toHaveBeenCalledWith('chat stalled');
    nudge.mockRestore();
  });

  test('silence past the stall budget fails the turn, stops the run and nudges', async () => {
    const nudge = jest.spyOn(OpenClawGatewayClient.prototype, 'nudge');
    adapter = new OpenClawAdapterClient(profile(), {}, { chatStallMs: 1_000 });
    const ws = await connected(adapter);
    const turn = adapter.streamChat(ask(), () => undefined);
    await flush();
    await ackChatSend(ws, { runId: 'run-1' });

    jest.advanceTimersByTime(1_000);
    await flush();

    await expect(turn).rejects.toThrow('The gateway connection stopped responding mid-turn');
    // Reads as a transport failure, so the provider keeps the bubble and
    // reconciles it from gateway history on the next healthy reconnect — the
    // same arm the connection-loss path takes. The message used to match no
    // token in `isConnectionError`, so the turn was failed instead.
    expect(isConnectionError(new Error('The gateway connection stopped responding mid-turn'))).toBe(true);
    // Best-effort stop, so a gateway that is still working does not keep billing.
    expect(ws.frames('session.abort')).toHaveLength(1);
    expect(nudge).toHaveBeenCalledWith('chat stalled');
    // Let the nudge's own probe run out, so nothing outlives the test.
    jest.advanceTimersByTime(60_000);
    await flush();
    nudge.mockRestore();
  });

  test('a frame inside the budget keeps the turn alive', async () => {
    adapter = new OpenClawAdapterClient(profile(), {}, { chatStallMs: 1_000 });
    const ws = await connected(adapter);
    const turn = adapter.streamChat(ask(), () => undefined);
    await flush();
    await ackChatSend(ws, { runId: 'run-1' });

    for (const step of [900, 900, 900]) {
      jest.advanceTimersByTime(step);
      await flush();
      ws.serverFrame(chat({ runId: 'run-1', state: 'delta', deltaText: 'x' }));
    }

    ws.serverFrame(chat({ runId: 'run-1', state: 'final' }));
    await expect(turn).resolves.toBe('xxx');
  });

  test('a normal turn still streams, resolves on final and clears its timer', async () => {
    adapter = new OpenClawAdapterClient(profile(), {}, { chatStallMs: 60_000 });
    const ws = await connected(adapter);
    const deltas: string[] = [];
    const timersBefore = jest.getTimerCount();
    const turn = adapter.streamChat(ask(), (text) => deltas.push(text));
    await flush();
    await ackChatSend(ws, { runId: 'run-1' });

    ws.serverFrame(chat({ runId: 'run-1', state: 'delta', deltaText: 'Hel' }));
    ws.serverFrame(chat({ runId: 'run-1', state: 'delta', message: { content: [{ type: 'text', text: 'lo' }] } }));
    ws.serverFrame(chat({ runId: 'run-1', state: 'final' }));

    await expect(turn).resolves.toBe('Hello');
    expect(deltas).toEqual(['Hel', 'lo']);
    // No timer of this turn's survives it.
    expect(jest.getTimerCount()).toBe(timersBefore);
  });

  test('an error frame rejects with the gateway\'s own words', async () => {
    adapter = new OpenClawAdapterClient(profile(), {}, { chatStallMs: 60_000 });
    const ws = await connected(adapter);
    const turn = adapter.streamChat(ask(), () => undefined);
    await flush();
    await ackChatSend(ws, { runId: 'run-1' });

    ws.serverFrame(chat({ runId: 'run-1', state: 'error', errorMessage: 'agent refused the prompt' }));

    await expect(turn).rejects.toThrow('agent refused the prompt');
  });

  test('Stop still rejects with Chat aborted and asks the gateway to stop', async () => {
    adapter = new OpenClawAdapterClient(profile(), {}, { chatStallMs: 60_000 });
    const ws = await connected(adapter);
    const controller = new AbortController();
    const turn = adapter.streamChat(ask(), () => undefined, { signal: controller.signal });
    await flush();
    await ackChatSend(ws, { runId: 'run-1' });

    controller.abort();
    await flush();

    await expect(turn).rejects.toThrow('Chat aborted');
    expect(ws.frames('session.abort')).toHaveLength(1);
  });

  test('Stop aborts the session the gateway adopted mid-turn, not the one it started on', async () => {
    adapter = new OpenClawAdapterClient(profile({ sessionId: 'oc_start' }), {}, { chatStallMs: 60_000 });
    const ws = await connected(adapter);
    const controller = new AbortController();
    const turn = adapter.streamChat(ask(), () => undefined, { signal: controller.signal });
    await flush();
    await ackChatSend(ws, { runId: 'run-1', sessionId: 'oc_adopted' });

    controller.abort();
    await flush();

    await expect(turn).rejects.toThrow('Chat aborted');
    const abort = ws.frames('session.abort').at(-1);
    // The turn the operator stopped is running on the session the gateway named.
    expect((abort?.params as { sessionId?: string })?.sessionId).toBe('oc_adopted');
  });
});

describe('OpenClawAdapterClient — chat.send timeouts', () => {
  const realWebSocket = globalThis.WebSocket;
  let randomSpy: jest.SpyInstance<number>;
  let request: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    FakeWebSocket.instances = [];
    mockLoadToken.mockReset().mockResolvedValue(null);
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    request = jest.spyOn(OpenClawGatewayClient.prototype, 'request');
  });

  afterEach(() => {
    request.mockRestore();
    randomSpy.mockRestore();
    jest.useRealTimers();
    (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  });

  test('the ack is given the same 120s the wire params ask the gateway for', async () => {
    // The wire is told to work for 120s; the RPC used to be bounded by the
    // client's 30s default, so at 30s the turn was dropped and every later delta
    // discarded while the gateway carried on.
    request.mockResolvedValue({});
    const controller = new AbortController();
    const adapter = new OpenClawAdapterClient(profile(), {}, { chatStallMs: 300_000 });
    const turn = adapter.streamChat(ask(), () => undefined, { signal: controller.signal });
    await flush();
    controller.abort();
    await expect(turn).rejects.toThrow('Chat aborted');

    const call = request.mock.calls.find(([method]) => method === 'chat.send');
    expect(call).toBeDefined();
    expect(call?.[2]).toBe(120000);
    expect((call?.[1] as Record<string, unknown>).timeoutMs).toBe(120000);
    adapter.disconnect();
  });

  test('a send into a dead connection fails on the connect bound, not after 120s', async () => {
    request.mockRestore();
    const adapter = new OpenClawAdapterClient(profile(), {}, { chatStallMs: 600_000 });
    // Never connected: the send waits for a socket that never comes.
    const turn = adapter.streamChat(ask(), () => undefined);
    const failed = expect(turn).rejects.toThrow('Gateway not connected');

    await advanceVirtualTime(31_000);

    await failed;
    adapter.disconnect();
  });

  test('the connect wait is a bound of its own, not the answer budget', async () => {
    request.mockRestore();
    const client = new OpenClawGatewayClient(profile(), {});
    const attempt = client.request('sessions.list', {}, 120_000, { connectTimeoutMs: 300 });
    const failed = expect(attempt).rejects.toThrow('Gateway not connected');

    await advanceVirtualTime(1_000);

    await failed;
    client.disconnect();
  });
});

describe('OpenClawAdapterClient — stale run frames', () => {
  const realWebSocket = globalThis.WebSocket;
  let randomSpy: jest.SpyInstance<number>;
  let adapter: OpenClawAdapterClient | undefined;

  beforeEach(() => {
    jest.useFakeTimers();
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    FakeWebSocket.instances = [];
    mockLoadToken.mockReset().mockResolvedValue(null);
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    adapter?.disconnect();
    adapter = undefined;
    randomSpy.mockRestore();
    jest.useRealTimers();
    (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  });

  test('a stopped run\'s late delta and error do not reach the turn that replaced it', async () => {
    adapter = new OpenClawAdapterClient(profile(), {}, { chatStallMs: 60_000 });
    const ws = await connected(adapter);

    const controller = new AbortController();
    const first = adapter.streamChat(ask('first'), () => undefined, { signal: controller.signal });
    await flush();
    await ackChatSend(ws, { runId: 'run-a' });
    controller.abort();
    await flush();
    await expect(first).rejects.toThrow('Chat aborted');

    const deltas: string[] = [];
    const second = adapter.streamChat(ask('second'), (text) => deltas.push(text));
    // Watched from the moment it is handed over, so a turn rejected by a frame
    // that was never its own shows up as a wrong answer rather than as an
    // unhandled rejection taking the worker with it.
    const settled = second.then(
      (text) => ({ text }),
      (error: Error) => ({ text: '', error: error.message }),
    );
    await flush();
    await ackChatSend(ws, { runId: 'run-b' });

    // Run A is retired; its stragglers answer to nobody.
    ws.serverFrame(chat({ runId: 'run-a', state: 'delta', deltaText: 'stale' }));
    ws.serverFrame(chat({ runId: 'run-a', state: 'error', errorMessage: 'stale failure' }));
    expect(deltas).toEqual([]);

    ws.serverFrame(chat({ runId: 'run-b', state: 'delta', deltaText: 'fresh' }));
    ws.serverFrame(chat({ runId: 'run-b', state: 'final' }));
    await expect(settled).resolves.toEqual({ text: 'fresh' });
    expect(deltas).toEqual(['fresh']);
  });

  test('two turns on a gateway that reuses one runId both complete', async () => {
    // A gateway whose runId is per-session rather than per-run retires that id
    // at the end of every turn. The retired set used to be consulted before the
    // pending match, so turn 2 had every frame — deltas and the final — dropped
    // as a straggler, hung for the whole stall budget and rejected. Turn 1
    // worked, which is why it read as fine.
    adapter = new OpenClawAdapterClient(profile({ sessionId: 'oc_1' }), {}, { chatStallMs: 60_000 });
    const ws = await connected(adapter);

    const first = adapter.streamChat(ask('first'), () => undefined);
    await flush();
    await ackChatSend(ws, { runId: 'shared-run' });
    ws.serverFrame(chat({ runId: 'shared-run', state: 'delta', deltaText: 'one' }));
    ws.serverFrame(chat({ runId: 'shared-run', state: 'final' }));
    await expect(first).resolves.toBe('one');

    const deltas: string[] = [];
    const second = adapter.streamChat(ask('second'), (text) => deltas.push(text));
    await flush();
    await ackChatSend(ws, { runId: 'shared-run' });
    ws.serverFrame(chat({ runId: 'shared-run', state: 'delta', deltaText: 'two' }));
    ws.serverFrame(chat({ runId: 'shared-run', state: 'final' }));

    await expect(second).resolves.toBe('two');
    expect(deltas).toEqual(['two']);
  });

  test('a frame with no runId still streams, for a gateway that sends none', async () => {
    adapter = new OpenClawAdapterClient(profile(), {}, { chatStallMs: 60_000 });
    const ws = await connected(adapter);
    const deltas: string[] = [];
    const turn = adapter.streamChat(ask(), (text) => deltas.push(text));
    await flush();
    await ackChatSend(ws, {});

    ws.serverFrame(chat({ state: 'delta', deltaText: 'one' }));
    ws.serverFrame(chat({ state: 'final' }));

    await expect(turn).resolves.toBe('one');
    expect(deltas).toEqual(['one']);
  });
});

describe('OpenClawAdapterClient — the provider\'s streamChat options', () => {
  const realWebSocket = globalThis.WebSocket;
  let randomSpy: jest.SpyInstance<number>;
  let adapter: OpenClawAdapterClient | undefined;

  beforeEach(() => {
    jest.useFakeTimers();
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    FakeWebSocket.instances = [];
    mockLoadToken.mockReset().mockResolvedValue(null);
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    adapter?.disconnect();
    adapter = undefined;
    randomSpy.mockRestore();
    jest.useRealTimers();
    (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  });

  test('a session the gateway adopts for the turn is reported once and adopted', async () => {
    adapter = new OpenClawAdapterClient(profile(), {}, { chatStallMs: 60_000 });
    const ws = await connected(adapter);
    const sessions: string[] = [];
    const turnIds: string[] = [];
    // Passed as a variable on purpose: an object literal would be rejected by the
    // old narrow signature as an excess property, and what matters here is that
    // the callback never fired.
    const options = {
      onSession: (sessionId: string) => sessions.push(sessionId),
      onTurnId: (turnId: string) => turnIds.push(turnId),
    };

    const turn = adapter.streamChat(ask(), () => undefined, options);
    await flush();
    await ackChatSend(ws, { sessionId: 'oc_adopted' });
    ws.serverFrame(chat({ state: 'final', deltaText: 'ok' }));

    await expect(turn).resolves.toBe('ok');
    expect(sessions).toEqual(['oc_adopted']);
    expect(adapter.sessionId).toBe('oc_adopted');
    // Never: the provider POSTs this id to the Gate, and this dialect stops
    // through `session.abort` instead.
    expect(turnIds).toEqual([]);
  });

  test('an acknowledgement naming the turn\'s own session reports nothing', async () => {
    adapter = new OpenClawAdapterClient(profile({ sessionId: 'oc_live' }), {}, { chatStallMs: 60_000 });
    const ws = await connected(adapter);
    const sessions: string[] = [];
    const turn = adapter.streamChat(ask(), () => undefined, { onSession: (id: string) => sessions.push(id) });
    await flush();
    await ackChatSend(ws, { sessionId: 'oc_live' });
    ws.serverFrame(chat({ state: 'final', deltaText: 'ok' }));

    await expect(turn).resolves.toBe('ok');
    expect(sessions).toEqual([]);
  });
});