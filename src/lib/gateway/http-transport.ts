import { GatewayHttpError } from '@/lib/gateway/errors';

export const DEFAULT_TIMEOUT_MS = 30000;

export type HttpTransportOptions = {
  baseUrl: string;
  token?: string;
  sessionKey?: string;
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

/** Fetch plumbing shared by every HTTP-dialect gateway client. */
export class HttpTransport {
  private contactAt = 0;

  constructor(private options: HttpTransportOptions) {}

  update(options: HttpTransportOptions) {
    this.options = options;
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
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
        let message: string;
        try {
          const parsed = JSON.parse(errorText);
          message = parsed?.error?.message || parsed?.error || errorText || `HTTP ${response.status}`;
        } catch {
          message = errorText || `HTTP ${response.status}`;
        }
        throw new GatewayHttpError(message, response.status);
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
  }

  /** Read an SSE body, invoking onChunk for each `data:` payload. */
  async streamSSE(
    response: Response,
    onChunk: (data: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body to stream');

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        if (signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') return;
          onChunk(data);
        }
      }
    } finally {
      reader.cancel();
    }
  }
}
