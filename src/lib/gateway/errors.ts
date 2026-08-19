/** An HTTP failure from the gateway, carrying the status for exact matching. */
export class GatewayHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GatewayHttpError';
  }
}

/**
 * True when the gateway refused our credentials. Prefers the HTTP status;
 * falls back to message text only for transports that lose the status.
 */
export function isAuthRejection(error: unknown): boolean {
  if (error instanceof GatewayHttpError) {
    return error.status === 401 || error.status === 403;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /(?:\b401\b|\b403\b|invalid api key|unauthorized|authentication required)/i.test(message);
}

/**
 * True when a failure is the user cancelling — our own AbortController firing,
 * or a genuine `AbortError` from fetch.
 *
 * Message text is deliberately never consulted. A substring test for "abort"
 * also matches server failures like "connection aborted by peer", which would
 * be silently swallowed as a cancellation instead of shown as the error it is.
 */
export function isUserAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error as { code?: unknown };
    // DOMException.ABORT_ERR is 20; Node and fetch polyfills use the name.
    return code === 'ABORT_ERR' || code === 20;
  }
  return false;
}

const GATEWAY_TOKEN_REQUIRED_MARKERS = [
  'setup token required',
  'auth token missing',
  'auth token not configured',
  'token required',
];

export function isGatewayTokenRequiredMessage(message?: string | null): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return GATEWAY_TOKEN_REQUIRED_MARKERS.some((marker) => normalized.includes(marker));
}

/**
 * True when an error looks like a transport/connection failure rather than a
 * gateway-side application error. Used to decide whether a mid-stream failure
 * should be marked as interrupted (recoverable) rather than failed.
 */
export function isConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(fetch|network|connection|reachable|timed out|timeout|econnrefused|ENOTFOUND|getaddrinfo|failed to fetch|aborted by peer|network error|stream closed unexpectedly)/i.test(
    message,
  );
}
