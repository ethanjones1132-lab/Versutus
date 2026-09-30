import { sanitizeHeaderValue } from '@/lib/gateway/http-transport';
import { withHostLookupRetry } from '@/lib/gateway/host-lookup';
import { httpToWsBase } from '@/lib/gateway/url';
import { streamingFetch } from '@/lib/net/streaming-fetch';
import { parseTerminalSseEvent, type TerminalSseFrame } from '@/lib/terminal/sse';

const TERMINAL_INPUT_TIMEOUT_MS = 15_000;

/**
 * Terminal input sends are ordered per session: two quick submits are
 * independent requests that can reorder on the wire, so each session's sends
 * chain onto the previous one. A failed send does not block later ones — the
 * chain swallows the rejection and the next send still dispatches.
 */
const inputQueues = new Map<string, Promise<void>>();

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
    },
  };
}

export function sendTerminalInput(
  gatewayWsUrl: string,
  sid: string,
  data: string,
  token?: string,
): Promise<void> {
  const key = queueKey(gatewayWsUrl, sid);
  const previous = inputQueues.get(key) ?? Promise.resolve();
  // Chain off the settled promise (catch first) so a rejected send does not
  // block the next one.
  const send = previous.catch(() => undefined).then(() =>
    dispatchTerminalInput(gatewayWsUrl, sid, data, token),
  );
  inputQueues.set(key, send);
  // Drop the entry once settled so the map cannot grow without bound.
  send.catch(() => undefined).finally(() => {
    if (inputQueues.get(key) === send) inputQueues.delete(key);
  });
  return send;
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
