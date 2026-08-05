import { Platform } from 'react-native';

import { httpToWsBase } from '@/lib/gateway/url';

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
  if (typeof globalThis.atob !== 'function') return '';
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function parseSseChunk(buffer: string): { events: Array<{ event?: string; data: string }>; rest: string } {
  const parts = buffer.split('\n\n');
  const complete = parts.slice(0, -1);
  const rest = parts[parts.length - 1] ?? '';
  const events: Array<{ event?: string; data: string }> = [];

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

export async function openTerminalSession(
  gatewayWsUrl: string,
  handlers: TerminalHandlers,
): Promise<TerminalSession> {
  const httpBase = httpToWsBase(gatewayWsUrl).replace(/^wss:/, "https://").replace(/^ws:/, "http://");
  const streamUrl = `${httpBase}/better-gateway/terminal/stream`;
  let sid = '';
  const setSid = (value: string) => {
    sid = value;
  };

  if (Platform.OS === 'web') {
    const source = new EventSource(streamUrl);

    source.addEventListener('session', (event) => {
      handleSseEvent({ event: 'session', data: (event as MessageEvent).data }, handlers, setSid);
    });
    source.addEventListener('error', (event) => {
      if (event instanceof MessageEvent) {
        handleSseEvent({ event: 'error', data: event.data }, handlers, setSid);
      } else {
        handlers.onError('Terminal stream disconnected');
      }
    });
    source.addEventListener('exit', (event) => {
      handleSseEvent({ event: 'exit', data: (event as MessageEvent).data }, handlers, setSid);
    });
    source.onmessage = (event) => {
      handleSseEvent({ data: event.data }, handlers, setSid);
    };

    for (let i = 0; i < 50 && !sid; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!sid) throw new Error('Terminal session id not received');

    return {
      sid,
      close: () => source.close(),
    };
  }

  const controller = new AbortController();
  const response = await fetch(streamUrl, { signal: controller.signal });
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

export async function sendTerminalInput(gatewayWsUrl: string, sid: string, data: string): Promise<void> {
  const httpBase = httpToWsBase(gatewayWsUrl).replace(/^wss:/, "https://").replace(/^ws:/, "http://");
  const response = await fetch(`${httpBase}/better-gateway/terminal/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sid, data }),
  });
  if (!response.ok) throw new Error(`Terminal input failed (${response.status})`);
}

export async function resizeTerminal(
  gatewayWsUrl: string,
  sid: string,
  cols: number,
  rows: number,
): Promise<void> {
  const httpBase = httpToWsBase(gatewayWsUrl).replace(/^wss:/, "https://").replace(/^ws:/, "http://");
  await fetch(`${httpBase}/better-gateway/terminal/resize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sid, cols, rows }),
  });
}