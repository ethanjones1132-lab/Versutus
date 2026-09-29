import { GatewayHttpError } from '@/lib/gateway/errors';
import { hostnameOf, withHostLookupRetry } from '@/lib/gateway/host-lookup';
import { errorCodeFromHttpBody, messageFromHttpErrorBody } from '@/lib/gateway/http-error-body';
import { installStreamingFetchHostFallback } from '@/lib/net/streaming-fetch';

export const DEFAULT_TIMEOUT_MS = 30000;

export type HttpTransportOptions = {
  baseUrl: string;
  token?: string;
  sessionKey?: string;
  /** IPv4s the Gate advertised (or the app already knows) for a DNS blip. */
  alternateIpv4?: string[];
};

/**
 * HTTP header values must be printable ASCII. Android's OkHttp rejects the
 * whole request — before any network I/O — if a value carries a control
 * character, so a token pasted with a stray newline fails every authenticated
 * call while unauthenticated probes to the same host keep succeeding.
 */
export function sanitizeHeaderValue(value: string | undefined): string {
  if (!value) return '';
  return value.replace(/[^\x20-\x7E]/g, '').trim();
}

/** A chat turn completes only after its stream reports a terminal marker. */
export function assertChatStreamComplete(
  completed: boolean,
  streamError: string | null,
  signal?: AbortSignal,
): void {
  if (streamError) throw new Error(streamError);
  if (signal?.aborted) throw new Error('Chat stream stopped');
  if (!completed) throw new Error('Chat stream closed unexpectedly before completion.');
}

/** Fetch plumbing shared by every HTTP-dialect gateway client. */
export class HttpTransport {
  private contactAt = 0;

  constructor(private options: HttpTransportOptions) {
    installStreamingFetchHostFallback(hostnameOf(options.baseUrl), options.alternateIpv4 ?? []);
  }

  update(options: HttpTransportOptions) {
    this.options = options;
    installStreamingFetchHostFallback(hostnameOf(options.baseUrl), options.alternateIpv4 ?? []);
  }

  get baseUrl(): string {
    return this.options.baseUrl.replace(/\/+$/, '');
  }

  /** Host portion of the gateway URL, for operator-facing status text. */
  get displayHost(): string {
    try {
      return new URL(this.baseUrl).host || this.baseUrl;
    } catch {
      return this.baseUrl;
    }
  }

  /** When the gateway last returned any response. Drives liveness. */
  get lastContactAt(): number {
    return this.contactAt;
  }

  get headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = sanitizeHeaderValue(this.options.token);
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const sessionKey = sanitizeHeaderValue(this.options.sessionKey);
    if (sessionKey) headers['X-Hermes-Session-Key'] = sessionKey;
    return headers;
  }

  async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    return withHostLookupRetry(
      `${this.baseUrl}${path}`,
      this.options.alternateIpv4 ?? [],
      async (url) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(url, {
            method,
            headers: { ...this.headers, ...extraHeaders },
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
          });
          clearTimeout(timer);
          // Any HTTP response proves the gateway is alive, including a rejection.
          this.contactAt = Date.now();

          if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new GatewayHttpError(
              messageFromHttpErrorBody(errorText, response.status),
              response.status,
              errorCodeFromHttpBody(errorText),
            );
          }

          const text = await response.text();
          try {
            return JSON.parse(text) as T;
          } catch {
            return text as unknown as T;
          }
        } catch (error) {
          clearTimeout(timer);
          if (error instanceof DOMException && error.name === 'AbortError') {
            throw new Error(`Request timed out: ${method} ${path}`);
          }
          throw error;
        }
      },
    );
  }

  /** Read an SSE body; return whether its terminal marker arrived. */
  async streamSSE(
    response: Response,
    onChunk: (data: string) => void,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body to stream');

    const decoder = new TextDecoder();
    let buffer = '';

    // A peer that never settles read()/cancel() must not pin the caller: race
    // both against the caller's abort so streamSSE always comes back false.
    const ABORTED = Symbol('streamSSE-aborted');
    let dropAbortListener: (() => void) | undefined;
    const abortSeen = new Promise<typeof ABORTED>((resolve) => {
      if (!signal) return;
      if (signal.aborted) {
        resolve(ABORTED);
        return;
      }
      dropAbortListener = () => resolve(ABORTED);
      signal.addEventListener('abort', dropAbortListener, { once: true });
    });

    const acceptLine = (line: string): boolean => {
      const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (!normalized.startsWith('data:')) return false;
      const raw = normalized.slice(5);
      const data = raw.startsWith(' ') ? raw.slice(1) : raw;
      if (data === '[DONE]') return true;
      onChunk(data);
      return false;
    };

    try {
      while (true) {
        if (signal?.aborted) return false;
        let frame: ReadableStreamReadResult<Uint8Array> | typeof ABORTED;
        try {
          frame = await Promise.race([reader.read(), abortSeen]);
        } catch (error) {
          if (signal?.aborted) return false;
          throw error;
        }
        // A read can settle in the same tick as an abort (a peer that aborts
        // synchronously then hands back bytes); neither its frame nor those
        // bytes count as fresh contact or a delivered token.
        if (frame === ABORTED || signal?.aborted) return false;
        if (frame.done) break;
        // Bytes just arrived from the gateway — the same class of liveness
        // evidence as a completed request(). Without this a long-running
        // chat or run-event stream produces no contact at all, and the
        // connection monitor can declare the gate down while frames are
        // still landing in the operator's hands.
        this.contactAt = Date.now();
        buffer += decoder.decode(frame.value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          // The abort can land between lines of one decoded frame: drop the
          // rest of the batch instead of handing the caller stale tokens.
          if (signal?.aborted) return false;
          if (acceptLine(line)) return true;
        }
      }
      buffer += decoder.decode();
      if (signal?.aborted) return false;
      if (buffer && acceptLine(buffer)) return true;
      return false;
    } finally {
      if (dropAbortListener && !signal?.aborted) {
        signal?.removeEventListener('abort', dropAbortListener);
      }
      // Best effort release only: awaiting a peer that ignores cancel would
      // pin an otherwise-complete stream. Sync throws and late rejections are
      // both swallowed so cleanup never rejects or stalls the caller.
      try {
        const releasing = reader.cancel() as Promise<void> | undefined;
        releasing?.catch?.(() => undefined);
      } catch {
        // cancel threw synchronously; there is nothing left to release.
      }
    }
  }
}
