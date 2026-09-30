import { bytesToBase64, utf8Encode } from '@/lib/encoding';
import { installStreamingFetch, resetStreamingFetchForTests } from '@/lib/net/streaming-fetch';
import { openTerminalSession, sendTerminalInput } from '@/lib/terminal/client';
import { parseTerminalSseEvent } from '@/lib/terminal/sse';

function b64(text: string): string {
  return bytesToBase64(utf8Encode(text));
}

function terminalSseResponse(frames: string[], close = true) {
  const body = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const frame of frames) controller.enqueue(enc.encode(frame));
      if (close) controller.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

async function flushPump() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

test('a truncated JSON session frame is skipped, not a shell error', () => {
  expect(parseTerminalSseEvent({ event: 'session', data: '{' })).toEqual({ kind: 'skip' });
  expect(parseTerminalSseEvent({ event: 'session', data: '{"sid":' })).toEqual({ kind: 'skip' });
});

test('a truncated JSON error frame is skipped, not a shell error', () => {
  expect(parseTerminalSseEvent({ event: 'error', data: '{' })).toEqual({ kind: 'skip' });
  expect(parseTerminalSseEvent({ event: 'error', data: '{"error":' })).toEqual({ kind: 'skip' });
});

test('a truncated JSON exit frame is skipped, not an exit', () => {
  expect(parseTerminalSseEvent({ event: 'exit', data: '{' })).toEqual({ kind: 'skip' });
  expect(parseTerminalSseEvent({ event: 'exit', data: '{"code":' })).toEqual({ kind: 'skip' });
});

test('a non-object JSON payload on a named event is skipped', () => {
  expect(parseTerminalSseEvent({ event: 'session', data: 'null' })).toEqual({ kind: 'skip' });
  expect(parseTerminalSseEvent({ event: 'error', data: '[]' })).toEqual({ kind: 'skip' });
  expect(parseTerminalSseEvent({ event: 'exit', data: '42' })).toEqual({ kind: 'skip' });
});

test('a well-formed session frame still yields the sid', () => {
  expect(parseTerminalSseEvent({ event: 'session', data: '{"sid":"sid-1"}' })).toEqual({
    kind: 'sid',
    sid: 'sid-1',
  });
});

test('a refused open still reports the error', () => {
  expect(
    parseTerminalSseEvent({
      event: 'session',
      data: '{"error":"too many terminal sessions open (limit 8)"}',
    }),
  ).toEqual({
    kind: 'error',
    message: 'too many terminal sessions open (limit 8)',
  });
});

test('a well-formed error frame still reports the error', () => {
  expect(parseTerminalSseEvent({ event: 'error', data: '{"error":"ENOENT: no shell"}' })).toEqual({
    kind: 'error',
    message: 'ENOENT: no shell',
  });
});

test('a well-formed error frame with no message still names a terminal error', () => {
  expect(parseTerminalSseEvent({ event: 'error', data: '{}' })).toEqual({
    kind: 'error',
    message: 'Terminal error',
  });
});

test('a well-formed exit frame still reports the code', () => {
  expect(parseTerminalSseEvent({ event: 'exit', data: '{"code":3}' })).toEqual({
    kind: 'exit',
    code: 3,
  });
});

test('an exit frame with no code is a zero exit', () => {
  expect(parseTerminalSseEvent({ event: 'exit', data: '{}' })).toEqual({ kind: 'exit', code: 0 });
});

test('an unnamed frame is decoded as output', () => {
  expect(parseTerminalSseEvent({ data: b64('hello\n') })).toEqual({
    kind: 'output',
    chunk: 'hello\n',
  });
});

test('a skip does not prevent the next well-formed frame from applying', () => {
  expect(parseTerminalSseEvent({ event: 'error', data: '{' })).toEqual({ kind: 'skip' });
  expect(parseTerminalSseEvent({ data: b64('still here\n') })).toEqual({
    kind: 'output',
    chunk: 'still here\n',
  });
  expect(parseTerminalSseEvent({ event: 'session', data: '{"sid":"sid-2"}' })).toEqual({
    kind: 'sid',
    sid: 'sid-2',
  });
});

describe('terminal stream close', () => {
  afterEach(() => resetStreamingFetchForTests());

  test('a clean end-of-stream with no exit frame fires onClose', async () => {
    const onClose = jest.fn();
    installStreamingFetch((async () =>
      terminalSseResponse(['event: session\ndata: {"sid":"sid-1"}\n\n'])) as unknown as typeof globalThis.fetch);

    const session = await openTerminalSession('ws://127.0.0.1:8760', {
      onOutput: jest.fn(),
      onError: jest.fn(),
      onExit: jest.fn(),
      onClose,
    });
    await flushPump();

    expect(session.sid).toBe('sid-1');
    expect(onClose).toHaveBeenCalledTimes(1);
    session.close();
  });

  test('an exit frame suppresses the close notification', async () => {
    const onClose = jest.fn();
    const onExit = jest.fn();
    installStreamingFetch((async () =>
      terminalSseResponse([
        'event: session\ndata: {"sid":"sid-1"}\n\n',
        'event: exit\ndata: {"code":0}\n\n',
      ])) as unknown as typeof globalThis.fetch);

    const session = await openTerminalSession('ws://127.0.0.1:8760', {
      onOutput: jest.fn(),
      onError: jest.fn(),
      onExit,
      onClose,
    });
    await flushPump();

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    session.close();
  });

  test('an intentional close does not fire onClose', async () => {
    const onClose = jest.fn();
    installStreamingFetch((async () =>
      terminalSseResponse(['event: session\ndata: {"sid":"sid-1"}\n\n'], false)) as unknown as typeof globalThis.fetch);

    const session = await openTerminalSession('ws://127.0.0.1:8760', {
      onOutput: jest.fn(),
      onError: jest.fn(),
      onExit: jest.fn(),
      onClose,
    });
    session.close();
    await flushPump();

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('sendTerminalInput', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
    jest.useRealTimers();
  });

  test('three sends back to back are dispatched in order', async () => {
    const calls: string[] = [];
    let releaseFirst!: (response: Response) => void;
    (globalThis as { fetch: unknown }).fetch = jest.fn((_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { data: string };
      calls.push(body.data);
      if (body.data === 'one') {
        // The first send stays in flight until released: a bare-fetch
        // implementation would already have dispatched the later two.
        return new Promise<Response>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve({ ok: true, status: 200 } as unknown as Response);
    });

    // Issue all three without awaiting: the per-session queue must preserve order.
    const first = sendTerminalInput('ws://127.0.0.1:8760', 'sid-order', 'one');
    const second = sendTerminalInput('ws://127.0.0.1:8760', 'sid-order', 'two');
    const third = sendTerminalInput('ws://127.0.0.1:8760', 'sid-order', 'three');
    await flushPump();

    // The later sends queue behind the first instead of dispatching at once.
    expect(calls).toEqual(['one']);

    releaseFirst({ ok: true, status: 200 } as unknown as Response);
    await Promise.all([first, second, third]);

    expect(calls).toEqual(['one', 'two', 'three']);
  });

  test('a rejected send does not block the next', async () => {
    const calls: string[] = [];
    let rejectFirst!: (reason: unknown) => void;
    (globalThis as { fetch: unknown }).fetch = jest.fn((_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { data: string };
      calls.push(body.data);
      if (body.data === 'first') {
        // The first send stays in flight until rejected: a bare-fetch
        // implementation would already have dispatched the second.
        return new Promise<Response>((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
      return Promise.resolve({ ok: true, status: 200 } as unknown as Response);
    });

    const first = sendTerminalInput('ws://127.0.0.1:8760', 'sid-reject', 'first');
    const second = sendTerminalInput('ws://127.0.0.1:8760', 'sid-reject', 'second');
    await flushPump();

    // The second send queues behind the first, rejected or not.
    expect(calls).toEqual(['first']);

    rejectFirst(new TypeError('fetch failed: Network request failed'));
    await expect(first).rejects.toThrow('Network request failed');
    await expect(second).resolves.toBeUndefined();

    expect(calls).toEqual(['first', 'second']);
  });

  test('a send times out and aborts', async () => {
    jest.useFakeTimers();
    const signals: AbortSignal[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((_url: unknown, init: RequestInit) => {
      signals.push(init.signal!);
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('canceled')));
      });
    });

    const pending = sendTerminalInput('ws://127.0.0.1:8760', 'sid-timeout', 'data');
    const assertion = expect(pending).rejects.toThrow('Terminal input timed out');
    await jest.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(signals[0]?.aborted).toBe(true);
  });

  test('an accepted send releases the response body', async () => {
    let cancelled = false;
    (globalThis as { fetch: unknown }).fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: {
          cancel: () => {
            cancelled = true;
            return Promise.resolve();
          },
        },
      } as unknown as Response),
    );

    await sendTerminalInput('ws://127.0.0.1:8760', 'sid-body', 'data');
    // Only the status was needed: the native connection must not stay open
    // until GC, and the 15s abort timer has already been cleared by then.
    expect(cancelled).toBe(true);
  });

  test('a refused send releases the response body too', async () => {
    let cancelled = false;
    (globalThis as { fetch: unknown }).fetch = jest.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        body: {
          cancel: () => {
            cancelled = true;
            return Promise.resolve();
          },
        },
      } as unknown as Response),
    );

    await expect(
      sendTerminalInput('ws://127.0.0.1:8760', 'sid-refused-body', 'data'),
    ).rejects.toThrow('Terminal input failed (500)');
    expect(cancelled).toBe(true);
  });
});
