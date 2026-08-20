import { httpToWsBase } from '@/lib/gateway/url';
import { base64ToBytes } from '@/lib/encoding';
import { streamingFetch } from '@/lib/net/streaming-fetch';

export type TerminalSession = {
  sid: string;
  close: () => void;
};

type TerminalHandlers = {
  onOutput: (chunk: string) => void;
  onError: (message: string) => void;
  onExit: (code: number) => void;
};

function decodeBase64Utf8(base64: string): string {
  // Previously this returned '' when `atob` was missing, so the pane showed a
  // connected session producing no output and reported nothing wrong -- the
  // silent-empty failure the Gate goes out of its way to avoid for chat turns.
  // Decoding directly removes both the dependency and the silent branch.
  return new TextDecoder().decode(base64ToBytes(base64));
}

function parseSseChunk(buffer: string): { events: { event?: string; data: string }[]; rest: string } {
  const parts = buffer.split('\n\n');
  const complete = parts.slice(0, -1);
  const rest = parts[parts.length - 1] ?? '';
  const events: { event?: string; data: string }[] = [];

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
  evt: { event?: string; data: string },
  handlers: TerminalHandlers,
  setSid: (sid: string) => void,
) {
  if (evt.event === 'session') {
    const payload = JSON.parse(evt.data) as { sid?: string; error?: string };
    if (payload.error) handlers.onError(payload.error);
    else if (payload.sid) setSid(payload.sid);
    return;
  }
  if (evt.event === 'error') {
    const payload = JSON.parse(evt.data) as { error?: string };
    handlers.onError(payload.error ?? 'Terminal error');
    return;
  }
  if (evt.event === 'exit') {
    const payload = JSON.parse(evt.data) as { code?: number };
    handlers.onExit(payload.code ?? 0);
    return;
  }
  handlers.onOutput(decodeBase64Utf8(evt.data));
}

function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
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

  const pump = async () => {
    try {
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseChunk(buffer);
        buffer = parsed.rest;
        for (const evt of parsed.events) handleSseEvent(evt, handlers, setSid);
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

export async function sendTerminalInput(
  gatewayWsUrl: string,
  sid: string,
  data: string,
  token?: string,
): Promise<void> {
  const httpBase = httpToWsBase(gatewayWsUrl).replace(/^wss:/, "https://").replace(/^ws:/, "http://");
  const response = await fetch(`${httpBase}/v1/terminal/input`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ sid, data }),
  });
  if (!response.ok) throw new Error(`Terminal input failed (${response.status})`);
}
