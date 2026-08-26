import { base64ToBytes } from '@/lib/encoding';

export type TerminalSseFrame = {
  event?: string;
  data: string;
};

/**
 * What to do with one terminal SSE frame. `skip` means the payload was not
 * usable JSON (or not an object). The pump keeps reading; the shell stays up.
 */
export type TerminalSseAction =
  | { kind: 'skip' }
  | { kind: 'sid'; sid: string }
  | { kind: 'error'; message: string }
  | { kind: 'exit'; code: number }
  | { kind: 'output'; chunk: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseFrameObject(data: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(data);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function decodeBase64Utf8(base64: string): string {
  // Previously this returned '' when `atob` was missing, so the pane showed a
  // connected session producing no output and reported nothing wrong -- the
  // silent-empty failure the Gate goes out of its way to avoid for chat turns.
  // Decoding directly removes both the dependency and the silent branch.
  return new TextDecoder().decode(base64ToBytes(base64));
}

/**
 * Interpret one terminal SSE frame. Named events (`session`, `error`, `exit`)
 * are JSON objects. A truncated or non-object payload is skipped so one bad
 * event cannot end the shell. Unnamed frames are base64 UTF-8 output.
 */
export function parseTerminalSseEvent(evt: TerminalSseFrame): TerminalSseAction {
  if (evt.event === 'session') {
    const payload = parseFrameObject(evt.data);
    if (!payload) return { kind: 'skip' };
    const error = payload.error;
    if (typeof error === 'string' && error) return { kind: 'error', message: error };
    const sid = payload.sid;
    if (typeof sid === 'string' && sid) return { kind: 'sid', sid };
    return { kind: 'skip' };
  }
  if (evt.event === 'error') {
    const payload = parseFrameObject(evt.data);
    if (!payload) return { kind: 'skip' };
    const error = payload.error;
    return {
      kind: 'error',
      message: typeof error === 'string' ? error : 'Terminal error',
    };
  }
  if (evt.event === 'exit') {
    const payload = parseFrameObject(evt.data);
    if (!payload) return { kind: 'skip' };
    const code = payload.code;
    return { kind: 'exit', code: typeof code === 'number' ? code : 0 };
  }
  return { kind: 'output', chunk: decodeBase64Utf8(evt.data) };
}
