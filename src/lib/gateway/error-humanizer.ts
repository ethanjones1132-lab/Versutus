import { GatewayHttpError, isAuthRejection, isGatewayTokenRequiredMessage, isUserAbort } from '@/lib/gateway/errors';
import { describeRunFailure } from '@/lib/gateway/run-failures';

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
  // The manual-add screen throws this shape when the typed/pasted address
  // cannot be canonicalized at all — an entry mistake, not a gateway fault.
  if (message.startsWith('Invalid gateway URL:')) {
    return {
      title: 'Gateway address looks wrong',
      cause: message,
      affected: 'gateway address',
      next: 'Fix the address and save again.',
      action: 'dismiss',
    };
  }
  if (isGatewayTokenRequiredMessage(message)) {
    return {
      title: 'Setup token required',
      cause: 'This gateway requires a setup or access token before it will talk to this device.',
      affected: 'gateway connection',
      next: 'Open gateway setup and paste the token.',
      action: 'setup',
    };
  }

  // Run/Bot-send failures carry their own verdict — the Gate names the host
  // state (multiplex off, refused key, dead environment, spent budget) in the
  // message it forwards. Classify before the network heuristic so e.g. a
  // spawn failure is not mistaken for a transport problem.
  const failureView = describeRunFailure(error instanceof Error ? error.message : String(error));
  if (failureView.kind !== 'generic') {
    return {
      title: failureView.title,
      cause: failureView.cause,
      affected: failureView.kind === 'environment_unreachable' || failureView.kind === 'time_limit' || failureView.kind === 'expired'
        ? 'remote task'
        : 'bot routing',
      next: failureView.next,
      action: 'copy',
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

export type ErrorBannerButton =
  | { kind: 'setup'; label: string }
  | { kind: 'reconnect'; label: string }
  | { kind: 'copy'; label: string }
  | { kind: 'dismiss' };

/**
 * Button on the chat error banner, keyed off the verdict
 * `humanizeGatewayError` already computed.
 *
 * Auth rejection says to open setup; a reconnect button would ignore that.
 * Copy-class errors are host-side. Dismiss has nothing to tap.
 */
export function errorBannerButton(action: HumanizedErrorAction): ErrorBannerButton {
  switch (action) {
    case 'setup':
      return { kind: 'setup', label: 'Open gateway setup' };
    case 'reconnect':
      return { kind: 'reconnect', label: 'Reconnect gateway' };
    case 'copy':
      return { kind: 'copy', label: 'Copy details' };
    case 'dismiss':
      return { kind: 'dismiss' };
  }
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
