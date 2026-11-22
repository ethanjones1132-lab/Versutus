import {
  DEVICE_IDENTITY_FAILURE,
  GatewayHttpError,
  isAuthRejection,
  isDeviceIdentityError,
  isGatewayTokenRequiredMessage,
  isUserAbort,
} from '@/lib/gateway/errors';
import { HostLookupError, isHostLookupFailure } from '@/lib/gateway/host-lookup';
import { describeRunFailure } from '@/lib/gateway/run-failures';

export type HumanizedErrorAction = 'reconnect' | 'setup' | 'copy' | 'dismiss';

export type HumanizedError = {
  title: string;
  cause: string;
  affected?: string;
  next?: string;
  action: HumanizedErrorAction;
};

const MISSING_PROVIDER_CREDENTIAL_MESSAGE = 'provider has no credential to send';

/**
 * The two backend endings the operator can fix from the sentence alone
 * (VS-127/VS-138): a backend signed out on their own PC, and one whose plan is
 * spent. The Gate names both with a stable code and a sentence that already
 * says the fix; the card leads with that fix instead of "Something went wrong".
 */
const BACKEND_SIGNED_OUT_TITLE = 'Sign in on your computer';
const BACKEND_QUOTA_TITLE = 'Switch backend or wait';

/** The Gate's machine-readable code for a refusal, when the transport kept it. */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.trim() ? code.trim() : undefined;
}

/**
 * A backend that is signed out, as the Gate writes it
 * (gate/core/voice/turn-failure.mjs): "<who> is signed out. <the one fix>".
 */
function looksSignedOutBackend(message: string): boolean {
  return /\bis signed out\b/i.test(message) && /\bsign in\b/i.test(message);
}

/**
 * A backend whose plan is spent, as the Gate writes it: "<who> has used up its
 * plan's limit. Until it resets, pick another backend." A bare rate limit is
 * not this — the Gate only names a quota when it also named the reset.
 */
function looksSpentBackendPlan(message: string): boolean {
  return /has used up its plan[’']?s limit/i.test(message);
}

/**
 * A turn the Gate refused before it reached the model vendor because the
 * provider record has no credential (gate/core/providers/service.mjs). The
 * typed code is the authority; the message is the fallback for transports that
 * keep only text. Neither is this phone's gateway token and neither is a
 * network fault, so both must be read before the auth/network heuristics.
 */
function isMissingProviderCredential(error: unknown, message: string): boolean {
  return (
    errorCodeOf(error) === 'missing_credentials'
    || message.trim() === MISSING_PROVIDER_CREDENTIAL_MESSAGE
  );
}

function describeChatRoutingRefusal(message: string): HumanizedError | undefined {
  const details = { cause: message, affected: 'chat routing', action: 'dismiss' as const };
  if (message.startsWith('This chat names no Bot, backend or model,')) {
    return {
      ...details,
      title: 'Choose where to chat',
      next: 'Open a Bot from the Roster, or pick a model in configurable chat.',
    };
  }
  if (/^Model ".*" is declared by multiple providers$/.test(message)) {
    return {
      ...details,
      title: 'Choose a provider for this model',
      next: 'Open the model picker and select this model from the provider you want to use.',
    };
  }
  if (/^No provider declares model ".*"$/.test(message)
    || /^model ".*" not found on provider ".*"$/.test(message)) {
    return {
      ...details,
      title: 'Model unavailable',
      next: 'Open the model picker and select an available model, or update the Bot\'s model pin.',
    };
  }
  if (/^Unknown provider ".*"$/.test(message)) {
    return {
      ...details,
      title: 'Provider unavailable',
      next: 'Pick a model from another provider, or restore this provider on the Gateway.',
    };
  }
  if (/^Provider ".*" does not support streaming$/.test(message)) {
    return {
      ...details,
      title: 'Streaming unavailable for this provider',
      next: 'Pick a model from a provider that supports streaming.',
    };
  }
  if (/^(?:This backend|Backend ".*") does not implement \w+$/.test(message)) {
    return {
      ...details,
      title: 'Capability unavailable',
      next: 'Choose a CLI environment that supports this capability; for Bot Chat, choose a Hermes Bot from the Roster.',
    };
  }
  return undefined;
}

/**
 * A backend the operator can fix, named as its own headline.
 *
 * The typed code is the authority. A transport that keeps only the text (the
 * chat stream flattens a failed frame to its message) still carries the Gate's
 * own sentence, so the wording is read only when no code survived — never over
 * a code that says something else.
 */
function describeBackendState(
  error: unknown,
  message: string,
): HumanizedError | undefined {
  const code = errorCodeOf(error);
  const signedOut = code === 'backend_signed_out'
    || (!code && looksSignedOutBackend(message));
  if (signedOut) {
    return {
      title: BACKEND_SIGNED_OUT_TITLE,
      cause: message,
      affected: 'this backend',
      next: 'Open a terminal on the computer that runs this backend and sign in, then retry.',
      action: 'copy',
    };
  }
  const quota = code === 'backend_quota' || (!code && looksSpentBackendPlan(message));
  if (quota) {
    return {
      title: BACKEND_QUOTA_TITLE,
      cause: message,
      affected: 'this backend',
      next: 'Pick a model from another backend, or wait until its limit resets.',
      action: 'copy',
    };
  }
  return undefined;
}

/**
 * Turn a raw gateway/transport error into a short, actionable surface.
 *
 * Keeps the cause/affected/next structure the UI already consumes, but maps
 * the common typed errors to text that reads like product language instead of
 * an exception dump.
 */
export function humanizeGatewayError(
  error: unknown,
  options: { sentDeviceId?: boolean } = {},
): HumanizedError {
  if (isUserAbort(error)) {
    return {
      title: 'Cancelled',
      cause: 'You cancelled the request.',
      action: 'dismiss',
    };
  }

  const message = error instanceof Error ? error.message : String(error);

  // A backend signed out on the operator's PC, or one whose plan is spent, is
  // named as its own headline. The code is the authority; the Gate's sentence
  // is the fallback for transports that drop the code (the chat stream keeps
  // only the message). This runs before the auth/network heuristics, which
  // would otherwise read "signed out" or a 401 quoted by a CLI as this phone's
  // gateway token.
  const backendState = describeBackendState(error, message);
  if (backendState) return backendState;

  // The Gate refused the turn because its provider record has no credential.
  // It arrives as a 409 carrying `code: missing_credentials`; a transport that
  // dropped the code still keeps the message. Saying "gateway error 409" (or,
  // worse, reading 401/403 as this phone's key) sends the operator to replace a
  // working gateway token instead of configuring the provider.
  if (isMissingProviderCredential(error, message)) {
    return {
      title: 'Model provider needs configuration',
      cause: 'The model provider has no credential, so the Gate had nothing to send. The gateway connection itself succeeded.',
      affected: 'model provider',
      next: 'Open Settings > Models and connections and add the provider key or sign in.',
      action: 'setup',
    };
  }

  // A model provider refusing the Gate's own upstream call arrives as
  // "chat failed: <status>" (gate/core/providers/profiles/registry.mjs). It is
  // not this device's gateway token: reading it as one sent the operator to
  // replace a token that was working (2026-09-16).
  const providerRefusal = /^(?:local provider )?chat failed: (\d{3})$/.exec(
    message.trim(),
  );
  if (providerRefusal) {
    return {
      title: 'Model provider refused the request',
      cause: `The model provider behind this chat refused it (${providerRefusal[1]}). Your gateway connection is fine.`,
      affected: 'this model',
      next: 'Open a Bot, or pick a model from a provider that is signed in.',
      action: 'dismiss',
    };
  }

  // Chat transports retain the Gate's message, but do not all retain its code.
  // Match its refusal templates before auth/network heuristics inspect model names.
  const routingRefusal = describeChatRoutingRefusal(message);
  if (routingRefusal) return routingRefusal;

  // A bootstrap-token phone that omitted its deviceId used to get this 403,
  // which the auth heuristic then called a rejected gateway key. Match it
  // before that heuristic. The identity module now refuses to send
  // anonymously, so a pairing_required refusal that reached a call *after* it
  // sent a deviceId is the Gate's own verdict — the phone named itself and
  // was still not read as paired — not a missing identity and not a rejected
  // key. A caller whose request carried the device marks that with
  // `sentDeviceId`; without it the anonymous-call reading stands.
  const pairingRequired =
    message === 'A paired device grant is required' || /pairing_required/i.test(message);
  if (
    isDeviceIdentityError(error)
    || message === DEVICE_IDENTITY_FAILURE
    || (!options.sentDeviceId && pairingRequired)
  ) {
    return {
      title: 'This phone has no device identity',
      cause: DEVICE_IDENTITY_FAILURE,
      affected: 'notifications and PC-powered calls',
      next: 'Reconnect. Versutus will try to make a new identity for this phone.',
      action: 'dismiss',
    };
  }
  if (options.sentDeviceId && pairingRequired) {
    return {
      title: 'The gateway does not treat this phone as paired',
      cause: 'The gateway refused this request as an unpaired device.',
      affected: 'notifications',
      next: 'Pair this phone with the gateway, then reopen notifications.',
      action: 'dismiss',
    };
  }

  // Run/Bot-send failures carry their own verdict — the Gate names the host
  // state (multiplex off, refused key, dead environment, spent budget) in the
  // message it forwards. Classify before the auth and network heuristics, so
  // e.g. a spawn failure is not mistaken for a transport problem, and a
  // provider's 401 forwarded inside a run failure is not read as this gateway's key.
  const failureView = describeRunFailure(message);

  if (failureView.kind === 'generic' && isAuthRejection(error)) {
    return {
      title: 'Gateway rejected the key',
      cause: 'The API key or token was refused.',
      affected: 'gateway connection',
      next: 'Open gateway setup and update the token.',
      action: 'setup',
    };
  }

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

  if (failureView.kind !== 'generic') {
    return {
      title: failureView.title,
      cause: failureView.cause,
      affected: failureView.kind === 'environment_unreachable' || failureView.kind === 'time_limit' || failureView.kind === 'expired'
        ? 'remote task'
        : failureView.kind === 'empty_turn'
          ? 'this turn'
          : 'bot routing',
      next: failureView.next,
      action: 'copy',
    };
  }

  if (error instanceof HostLookupError || isHostLookupFailure(error)) {
    const hostname = error instanceof HostLookupError ? error.hostname : undefined;
    return {
      title: 'The phone could not look up your PC',
      cause: hostname
        ? `The phone could not look up your PC's address (${hostname}).`
        : "The phone could not look up your PC's address.",
      affected: 'gateway connection',
      next: 'Stay on the tailnet and retry. If this keeps happening, reconnect using the PC\'s tailnet IP.',
      action: 'reconnect',
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
export function describeGatewayError(
  error: unknown,
  options?: { sentDeviceId?: boolean },
): string {
  const { cause, next } = humanizeGatewayError(error, options);
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
