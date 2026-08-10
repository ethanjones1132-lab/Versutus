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
