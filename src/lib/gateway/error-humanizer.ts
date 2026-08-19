import { GatewayHttpError, isAuthRejection, isGatewayTokenRequiredMessage, isUserAbort } from '@/lib/gateway/errors';

export type HumanizedErrorAction = 'reconnect' | 'setup' | 'copy' | 'dismiss';

export type HumanizedError = {
  title: string;
  cause: string;
  affected?: string;
  next?: string;
  action: HumanizedErrorAction;
};

/**
 * Turn a raw gateway/transport error into a short, actionable surface.
 *
 * Keeps the cause/affected/next structure the UI already consumes, but maps
 * the common typed errors to text that reads like product language instead of
 * an exception dump.
 */
export function humanizeGatewayError(error: unknown): HumanizedError {
  if (isUserAbort(error)) {
    return {
      title: 'Cancelled',
      cause: 'You cancelled the request.',
      action: 'dismiss',
    };
  }

  if (isAuthRejection(error)) {
    return {
      title: 'Gateway rejected the key',
      cause: 'The API key or token was refused.',
      affected: 'gateway connection',
      next: 'Open gateway setup and update the token.',
      action: 'setup',
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  if (isGatewayTokenRequiredMessage(message)) {
    return {
      title: 'Setup token required',
      cause: 'This gateway requires a setup or access token before it will talk to this device.',
      affected: 'gateway connection',
      next: 'Open gateway setup and paste the token.',
      action: 'setup',
    };
  }

  const looksNetwork =
    /(fetch|network|connection|reachable|timed out|timeout|econnrefused|ENOTFOUND|getaddrinfo|failed to fetch)/i.test(
      message,
    );
  if (looksNetwork) {
    return {
      title: 'Could not reach the gateway',
      cause: message,
      affected: 'gateway connection',
      next: 'Check that the gateway is running and reachable, then retry.',
      action: 'reconnect',
    };
  }

  if (error instanceof GatewayHttpError) {
    return {
      title: `Gateway error ${error.status}`,
      cause: message,
      affected: 'gateway request',
      next: 'If this persists, check the gateway logs or reconnect.',
      action: 'reconnect',
    };
  }

  return {
    title: 'Something went wrong',
    cause: message,
    affected: 'gateway connection',
    next: 'Check the details below and try again.',
    action: 'copy',
  };
}

/**
 * One-line prose form, for surfaces that take a plain string instead of an
 * `ErrorCard` — empty states, banners, notification bodies.
 *
 * Without this, those callers hand-rolled their own `Cause: … Affected: … Next: …`
 * template around the raw exception, which is exactly the dev-speak the
 * humanizer exists to remove.
 */
export function describeGatewayError(error: unknown): string {
  const { cause, next } = humanizeGatewayError(error);
  const trimmedCause = cause.trim();
  if (!next) return trimmedCause;
  const separator = /[.!?]$/.test(trimmedCause) ? ' ' : '. ';
  return `${trimmedCause}${separator}${next.trim()}`;
}

/**
 * Parse a raw error string that may already contain Cause/Affected/Next lines
 * into the structured ErrorCard props. Used as a fallback for messages that
 * were emitted before humanizeGatewayError existed.
 */
export function parseStructuredError(message: string): {
  cause?: string;
  affected?: string;
  next?: string;
} {
  const valueAfter = (label: string): string | undefined => {
    const pattern = new RegExp(`${label}:\\s*([^\\n]+?)(?=\\s*(?:Cause|Affected|Next):|$)`, 'i');
    return message.match(pattern)?.[1]?.trim();
  };
  const cause = valueAfter('Cause');
  const affected = valueAfter('Affected');
  const next = valueAfter('Next');
  if (!cause && !affected && !next) {
    return { cause: message };
  }
  return {
    cause: cause ?? message,
    affected,
    next,
  };
}
