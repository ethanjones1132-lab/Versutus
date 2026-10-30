import { sanitizeHeaderValue } from '@/lib/gateway/http-transport';
import { withHostLookupRetry } from '@/lib/gateway/host-lookup';
import { httpToWsBase } from '@/lib/gateway/url';
import { streamingFetch } from '@/lib/net/streaming-fetch';
import { parseTerminalSseEvent, type TerminalSseFrame } from '@/lib/terminal/sse';

const TERMINAL_INPUT_TIMEOUT_MS = 15_000;
// A stalled transport (a hung gateway) must never accumulate keystrokes that
// would dispatch minutes later: at most this many sends may WAIT per session,
// behind the one in flight. Further callers are refused promptly, with no
// transport call, until the backlog drains or its payloads are dropped.
const TERMINAL_INPUT_MAX_WAITING = 4;

/**
 * Terminal input is serialized per session: two quick submits are independent
 * requests that can reorder on the wire, so a session dispatches one send at a
 * time and keeps later ones waiting, in order. The per-session backlog is
 * bounded (@link TERMINAL_INPUT_MAX_WAITING) and a failed or stalled send
 * invalidates every payload still queued behind it — stale keystrokes must
 * never dispatch after that failure. A send issued after the failure starts a
 * fresh queue, and closing the session retires its unsent sends.
 */
type WaitingTerminalInput = {
  dispatch: () => Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
};

type TerminalInputQueue = {
  inFlight: Promise<void> | undefined;
  waiting: WaitingTerminalInput[];
};

const inputQueues = new Map<string, TerminalInputQueue>();

function queueKey(gatewayWsUrl: string, sid: string): string {
  return `${gatewayWsUrl}|${sid}`;
}

export type TerminalSession = {
  sid: string;
  close: () => void;
};

type TerminalHandlers = {
  onOutput: (chunk: string) => void;
  onError: (message: string) => void;
  onExit: (code: number) => void;
  onClose: () => void;
};

function parseSseChunk(buffer: string): { events: TerminalSseFrame[]; rest: string } {
  const parts = buffer.split('\n\n');
  const complete = parts.slice(0, -1);
  const rest = parts[parts.length - 1] ?? '';
  const events: TerminalSseFrame[] = [];

  for (const part of complete) {
    if (!part.trim() || part.startsWith(':')) continue;
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of part.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length) events.push({ event, data: dataLines.join('\n') });
  }

  return { events, rest };
}

function handleSseEvent(
  evt: TerminalSseFrame,
  handlers: TerminalHandlers,
  setSid: (sid: string) => void,
) {
  const action = parseTerminalSseEvent(evt);
  switch (action.kind) {
    case 'skip':
      return;
    case 'sid':
      setSid(action.sid);
      return;
    case 'error':
      handlers.onError(action.message);
      return;
    case 'exit':
      handlers.onExit(action.code);
      return;
    case 'output':
      handlers.onOutput(action.chunk);
      return;
  }
}

function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // A control character in the value makes OkHttp reject the request before it
  // is sent ("Unexpected char 0x0d ... in Authorization value").
  const clean = sanitizeHeaderValue(token);
  if (clean) headers['Authorization'] = `Bearer ${clean}`;
  return headers;
}

export async function openTerminalSession(
  gatewayWsUrl: string,
  handlers: TerminalHandlers,
  token?: string,
): Promise<TerminalSession> {
  const httpBase = httpToWsBase(gatewayWsUrl).replace(/^wss:/, "https://").replace(/^ws:/, "http://");
  const streamUrl = `${httpBase}/v1/terminal/stream`;
  let sid = '';
  const setSid = (value: string) => {
    sid = value;
  };

  const controller = new AbortController();
  const response = await streamingFetch(streamUrl, {
    headers: authHeaders(token),
    signal: controller.signal,
  });
  if (!response.ok) throw new Error(`Terminal stream failed (${response.status})`);

  const reader = response.body?.getReader();
  if (!reader) throw new Error('Terminal streaming is not supported on this device');

  const decoder = new TextDecoder();
  let buffer = '';
  let closed = false;
  let reported = false;

  const pumpHandlers: TerminalHandlers = {
    onOutput: handlers.onOutput,
    onError: (message) => {
      reported = true;
      handlers.onError(message);
    },
    onExit: (code) => {
      reported = true;
      handlers.onExit(code);
    },
    onClose: handlers.onClose,
  };

  const pump = async () => {
    try {
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) {
          if (!reported && !closed && !controller.signal.aborted) handlers.onClose();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseChunk(buffer);
        buffer = parsed.rest;
        for (const evt of parsed.events) handleSseEvent(evt, pumpHandlers, setSid);
      }
    } catch (error) {
      if (!closed && !controller.signal.aborted) {
        handlers.onError(error instanceof Error ? error.message : String(error));
      }
    }
  };

  void pump();

  for (let i = 0; i < 50 && !sid; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!sid) {
    controller.abort();
    throw new Error('Terminal session id not received');
  }

  return {
    sid,
    close: () => {
      closed = true;
      controller.abort();
      reader.cancel().catch(() => undefined);
      // The session is gone: payloads still queued behind an in-flight send can
      // no longer be delivered usefully. Retire them instead of replaying
      // stale input through a stream that no longer exists.
      if (sid) retireTerminalInput(gatewayWsUrl, sid, 'the terminal session was closed');
    },
  };
}

/**
 * Queue one send for the session, FIFO behind whatever is in flight. Excess
 * callers are refused without a transport call, and a failed or stalled send
 * drops everything still queued behind it.
 */
export function sendTerminalInput(
  gatewayWsUrl: string,
  sid: string,
  data: string,
  token?: string,
): Promise<void> {
  const key = queueKey(gatewayWsUrl, sid);
  const queue = inputQueues.get(key);
  if (queue && queue.waiting.length >= TERMINAL_INPUT_MAX_WAITING) {
    return Promise.reject(
      new Error(
        `Terminal input backlog is full (${TERMINAL_INPUT_MAX_WAITING} sends waiting for this session); input was not sent`,
      ),
    );
  }
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const pending = new Promise<void>((settled, unsettled) => {
    resolve = settled;
    reject = unsettled;
  });
  const slot: WaitingTerminalInput = {
    dispatch: () => dispatchTerminalInput(gatewayWsUrl, sid, data, token),
    resolve,
    reject,
  };
  if (queue) queue.waiting.push(slot);
  else inputQueues.set(key, { inFlight: undefined, waiting: [slot] });
  drainTerminalInputQueue(key);
  return pending;
}

/**
 * Dispatch the next waiting send for the session, one at a time, so two quick
 * submits cannot reorder on the wire. Called again when the in-flight send
 * settles; drops the map entry once the queue goes idle.
 */
function drainTerminalInputQueue(key: string): void {
  const queue = inputQueues.get(key);
  if (!queue || queue.inFlight) return;
  const slot = queue.waiting.shift();
  if (!slot) {
    // Nothing left to dispatch: release the entry so the map cannot grow.
    if (inputQueues.get(key) === queue) inputQueues.delete(key);
    return;
  }
  const run = slot.dispatch();
  run.then(slot.resolve, slot.reject);
  queue.inFlight = run
    .then(
      () => undefined,
      (error) => {
        // A failed or stalled send invalidates every payload still queued
        // behind it: stale input must never dispatch after that failure. A
        // later explicit send recreates the queue and starts over cleanly.
        const stale = new Error(
          error instanceof Error && error.message
            ? `Terminal input dropped: an earlier send for this session failed (${error.message})`
            : 'Terminal input dropped: an earlier send for this session failed',
        );
        dropWaitingTerminalInput(key, queue, stale);
        throw error;
      },
    )
    .catch(() => undefined)
    .finally(() => {
      // Identity-checked: an old finalizer must never touch a queue that a
      // newer generation of sends has already replaced.
      if (inputQueues.get(key) !== queue) return;
      queue.inFlight = undefined;
      drainTerminalInputQueue(key);
    });
}

/** Reject the payload a session still has queued and release its queue entry. */
function dropWaitingTerminalInput(key: string, queue: TerminalInputQueue, error: Error): void {
  const waiting = queue.waiting;
  queue.waiting = [];
  for (const slot of waiting) slot.reject(error);
  if (inputQueues.get(key) === queue) inputQueues.delete(key);
}

/** Retire a session's unsent input (unsent work only; the in-flight call stands). */
function retireTerminalInput(gatewayWsUrl: string, sid: string, reason: string): void {
  const key = queueKey(gatewayWsUrl, sid);
  const queue = inputQueues.get(key);
  if (!queue) return;
  dropWaitingTerminalInput(key, queue, new Error(`Terminal input dropped: ${reason}`));
}

async function dispatchTerminalInput(
  gatewayWsUrl: string,
  sid: string,
  data: string,
  token?: string,
): Promise<void> {
  const httpBase = httpToWsBase(gatewayWsUrl).replace(/^wss:/, "https://").replace(/^ws:/, "http://");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TERMINAL_INPUT_TIMEOUT_MS);
  let response: Response | undefined;
  try {
    response = await withHostLookupRetry(
      `${httpBase}/v1/terminal/input`,
      [],
      (url) =>
        fetch(url, {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({ sid, data }),
          signal: controller.signal,
        }),
    );
    if (!response.ok) throw new Error(`Terminal input failed (${response.status})`);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Terminal input timed out: POST /v1/terminal/input`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    // Only the status was needed: release the body so the connection does not
    // stay open until GC — the 15s timer never covers it.
    try {
      const releasing = response?.body?.cancel() as Promise<void> | undefined;
      releasing?.catch?.(() => undefined);
    } catch {
      // cancel threw synchronously; there is nothing left to release.
    }
  }
}
