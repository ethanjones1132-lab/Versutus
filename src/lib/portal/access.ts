// ─── Universal access request ─────────────────────────────────────
// "Identify, then request access" — one handshake, per-kind dialect.
// See docs/portal-architecture.md §4.
//
// Result contract:
//   granted           → token returned (stored on the profile)
//   pending-approval  → gateway-side approval required (OpenClaw pairing)
//   token-required    → user must supply a token (Hermes API key today)
//   denied            → gateway refused — a verdict it actually gave
//   unreachable       → nothing answered: a dead path, not a refusal
//   device-identity   → this phone could not make its device identity

import Constants from 'expo-constants';
import { httpToWsBase } from '@/lib/gateway/url';
import { loadOrCreateDeviceIdentity, signDevicePayload } from '@/lib/gateway/device-identity';
import { DEVICE_IDENTITY_FAILURE, isDeviceIdentityError } from '@/lib/gateway/errors';
import { advertisedIpv4, ipv4FromExpoExtra, withHostLookupRetry } from '@/lib/gateway/host-lookup';
import { OpenClawGatewayClient } from '@/lib/gateway/openclaw-client';
import type { GatewayHelloOk, PairingDetails } from '@/lib/gateway/types';
import { GATEWAY_MANIFEST_SPEC } from '@/lib/portal/manifest';
import type { GatewayIdentity } from '@/lib/portal/identify';

export type AccessRequestResult =
  | { status: 'granted'; token: string; role?: string; scopes?: string[] }
  | { status: 'pending-approval'; requestId?: string; hint?: string }
  | { status: 'token-required'; hint?: string }
  | { status: 'denied'; reason: string }
  | { status: 'unreachable'; reason: string }
  | { status: 'device-identity'; reason: string };

export type RequestGatewayAccessOptions = {
  baseUrl: string;
  identity: GatewayIdentity;
  /** Existing setup token (used as the signature token for OpenClaw). */
  token?: string;
  role?: string;
  scopes?: string[];
  timeoutMs?: number;
  /**
   * Tailnet IPv4s this gateway may answer on, when the caller holds a set the
   * manifest and the configured hosts do not describe. Defaults to both.
   */
  alternateIpv4?: string[];
};

// ─── Pending-approval hint ────────────────────────────────────────
// Pairing Order B: the request sits on the Gate until a human approves it.
// The operator is holding the phone while the approval command runs on the
// Gate machine — "approve it on the gateway" sends them to the runbook
// mid-flow. Name the exact command instead, and the exact requestId when
// the Gate returned one, so no cross-referencing `pair list` by hand.

/**
 * The requestId comes straight off the wire from an unverified gateway and is
 * rendered as a shell command a human is expected to paste into their Gate
 * machine — so only plain id characters may ever be embedded. Anything else
 * (shell metacharacters, quotes, newlines that would smuggle a second
 * command into a copy-paste block) falls back to the pair-list walk, which
 * is always safe to show (rook 2026-08-24). Real gate ids are UUIDs or short
 * slugs; this pattern admits both.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function pendingApprovalHint(requestId?: string): string {
  const id = requestId?.trim();
  if (!id || !REQUEST_ID_PATTERN.test(id)) {
    return [
      'Access request sent — waiting for approval. On the Gate machine run:',
      '',
      'node gate/cli.mjs pair list',
      '',
      'to see open requests, then run:',
      '',
      'node gate/cli.mjs pair approve <requestId>',
      '',
      'then tap Save & connect again.',
    ].join('\n');
  }
  return [
    'Access request sent — waiting for approval. On the Gate machine run:',
    '',
    `node gate/cli.mjs pair approve ${id}`,
    '',
    'then tap Save & connect again.',
  ].join('\n');
}

const CLIENT_ID = 'versutus-mobile';
const CLIENT_MODE = 'ui';
const DEFAULT_SCOPES = ['chat:send', 'chat:read', 'runs:start', 'runs:read', 'terminal:use', 'sessions:manage'];

export async function requestGatewayAccess(
  options: RequestGatewayAccessOptions,
): Promise<AccessRequestResult> {
  const { identity } = options;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  switch (identity.kind) {
    case 'hermes':
      return requestHermesAccess(options, baseUrl);
    case 'openclaw':
      return requestOpenClawAccess(options);
    case 'custom':
      return requestCustomAccess(options, baseUrl);
    default:
      return { status: 'token-required', hint: 'This gateway was not identified. Supply its access token to connect.' };
  }
}

// ─── Hermes ───────────────────────────────────────────────────────

async function requestHermesAccess(
  options: RequestGatewayAccessOptions,
  baseUrl: string,
): Promise<AccessRequestResult> {
  const grantPath = options.identity.manifest?.auth?.grantPath;
  if (!grantPath) {
    return {
      status: 'token-required',
      hint: 'This Hermes gateway uses an API token. Paste it to connect (API_SERVER_KEY).',
    };
  }
  return postSignedAccessRequest(baseUrl, grantPath, options);
}

// ─── OpenClaw (WS v4 pairing) ─────────────────────────────────────

/**
 * The tailnet addresses this gateway may answer on: what its manifest
 * advertised, plus the configured hosts — the same set the signed POST retries
 * over. A WebSocket dial has no retry seam of its own, so this list rides the
 * probe profile and the client rotates onto an address of its own when the
 * hostname misses MagicDNS.
 */
function fallbackIpv4(options: RequestGatewayAccessOptions): string[] {
  return (
    options.alternateIpv4 ??
    advertisedIpv4({
      advertised: options.identity.manifest?.transport?.ipv4,
      configuredHosts: ipv4FromExpoExtra(Constants.expoConfig?.extra),
    })
  );
}

async function requestOpenClawAccess(options: RequestGatewayAccessOptions): Promise<AccessRequestResult> {
  const wsUrl = `${httpToWsBase(options.baseUrl)}/openclaw`;
  const profile = {
    id: 'access-probe',
    name: 'Access probe',
    url: wsUrl,
    token: options.token,
    createdAt: Date.now(),
    alternateIpv4: fallbackIpv4(options),
  };

  return new Promise<AccessRequestResult>((resolve) => {
    let settled = false;
    let client: OpenClawGatewayClient | null = null;
    // The client publishes transport facts and gateway verdicts on one channel:
    // onError fires for a dial that never reached the gateway ("Could not reach
    // gateway at …", "closed before handshake completed", "handshake timed out")
    // as well as for a gateway that answered and refused. The only verdict it
    // flags is a rejected credential, so that flag — and nothing weaker — is
    // what keeps a result filed as denied. A failure we cannot show to be the
    // gateway's answer is a dead path: reporting it as a refusal sends the
    // operator hunting for a credential problem they do not have.
    let gatewayRefused = false;

    const finish = (result: AccessRequestResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client?.disconnect();
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ status: 'unreachable', reason: 'OpenClaw gateway did not answer the access request in time.' }),
      options.timeoutMs ?? 15000,
    );

    client = new OpenClawGatewayClient(profile, {
      onStatus: (_status, _detail, info) => {
        // A refusal raises this one statement after onError returns, so it is
        // read by the deferred classification below — never here.
        if (info?.authRejected) gatewayRefused = true;
      },
      onHello: (hello: GatewayHelloOk) => {
        if (hello.auth?.deviceToken) {
          finish({
            status: 'granted',
            token: hello.auth.deviceToken,
            role: hello.auth.role,
            scopes: hello.auth.scopes,
          });
        } else {
          finish({ status: 'granted', token: '', role: hello.auth?.role, scopes: hello.auth?.scopes });
        }
      },
      onPairingRequired: (details: PairingDetails) => {
        finish({
          status: 'pending-approval',
          requestId: details.requestId,
          hint: details.remediationHint ?? 'Approve this device on the gateway to finish pairing.',
        });
      },
      onError: (message: string) => {
        // One microtask of patience: the client finishes classifying the
        // failure after onError returns, so a verdict read synchronously here
        // would always be the previous attempt's.
        void Promise.resolve().then(() => {
          finish(
            gatewayRefused
              ? { status: 'denied', reason: message }
              : { status: 'unreachable', reason: message },
          );
        });
      },
    });

    client.connect();
  });
}

// ─── Custom (manifest-driven) ─────────────────────────────────────

async function requestCustomAccess(
  options: RequestGatewayAccessOptions,
  baseUrl: string,
): Promise<AccessRequestResult> {
  const grantPath = options.identity.manifest?.auth?.grantPath;
  if (!grantPath) {
    const schemes = options.identity.auth.schemes;
    if (schemes.includes('none')) return { status: 'granted', token: '' };
    return {
      status: 'token-required',
      hint: `This custom gateway (${options.identity.kindLabel}) does not advertise an access endpoint. Supply its token.`,
    };
  }
  return postSignedAccessRequest(baseUrl, grantPath, options);
}

// ─── Shared signed access POST ────────────────────────────────────

async function postSignedAccessRequest(
  baseUrl: string,
  grantPath: string,
  options: RequestGatewayAccessOptions,
): Promise<AccessRequestResult> {
  const signedAtMs = Date.now();
  const role = options.role ?? 'operator';
  const scopes = options.scopes ?? DEFAULT_SCOPES;

  // Signing needs the phone's ed25519 identity; a load or sign failure is this
  // phone's problem, not the gateway's verdict. Classify it as its own result
  // so the manual-add flow renders the humanized identity failure instead of a
  // warm "denied", and never echo the raw error — a storage or key fault could
  // name the phone's private key material.
  let signedDevice: { deviceId: string; publicKeyB64Url: string; signature: string };
  try {
    const identity = await loadOrCreateDeviceIdentity();
    const payload = [
      'v4',
      identity.deviceId,
      CLIENT_ID,
      role,
      scopes.join(','),
      String(signedAtMs),
    ].join('|');
    signedDevice = {
      deviceId: identity.deviceId,
      publicKeyB64Url: identity.publicKeyB64Url,
      signature: await signDevicePayload(identity, payload),
    };
  } catch (error) {
    return {
      status: 'device-identity',
      reason: isDeviceIdentityError(error) ? error.message : DEVICE_IDENTITY_FAILURE,
    };
  }

  try {
    const url = `${baseUrl}${grantPath}`;
    const body = JSON.stringify({
      manifest: GATEWAY_MANIFEST_SPEC,
      device: {
        id: signedDevice.deviceId,
        publicKey: signedDevice.publicKeyB64Url,
        clientId: CLIENT_ID,
        clientMode: CLIENT_MODE,
      },
      role,
      scopes,
      signedAtMs,
      signature: signedDevice.signature,
      client: { name: 'Versutus', version: '1.0.0', platform: 'mobile' },
    });
    const timeoutMs = options.timeoutMs ?? 10000;

    // The same tails the ordinary Gate requests retry over: what this gate
    // advertised when it was just identified, plus the configured hosts the
    // adapters install on a profile — all present here before any client or
    // profile exists. A host lookup miss on the request is retried onto them;
    // https is never rewritten (withHostLookupRetry keeps an https host). The
    // body and device identity are identical on every attempt.
    const alternateIpv4 = fallbackIpv4(options);

    const response = await withHostLookupRetry(url, alternateIpv4, async (candidateUrl) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // Awaited, so the timer outlives the request: returning the bare
        // promise cleared it at once and the access request had no timeout.
        return await fetch(candidateUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body,
        });
      } finally {
        clearTimeout(timer);
      }
    });

    if (response.status === 404 || response.status === 405) {
      return { status: 'token-required', hint: 'This gateway does not serve universal access requests. Supply its token.' };
    }

    const parsedBody = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const status = typeof parsedBody?.status === 'string' ? parsedBody.status : undefined;
    if (response.ok && status === 'granted' && typeof parsedBody?.token === 'string') {
      return {
        status: 'granted',
        token: parsedBody.token,
        role: typeof parsedBody.role === 'string' ? parsedBody.role : undefined,
        scopes: Array.isArray(parsedBody.scopes) ? parsedBody.scopes.filter((s): s is string => typeof s === 'string') : undefined,
      };
    }
    if (response.status === 202 || status === 'pending') {
      const requestId = typeof parsedBody?.requestId === 'string' ? parsedBody.requestId : undefined;
      return {
        status: 'pending-approval',
        requestId,
        hint: pendingApprovalHint(requestId),
      };
    }
    if (status === 'token-required') {
      return { status: 'token-required', hint: typeof parsedBody?.hint === 'string' ? parsedBody.hint : undefined };
    }
    if (response.status === 403 || status === 'denied') {
      return {
        status: 'denied',
        reason: typeof parsedBody?.reason === 'string' ? parsedBody.reason : 'The gateway denied the access request.',
      };
    }
    return { status: 'denied', reason: `Unexpected access response (HTTP ${response.status}).` };
  } catch (error) {
    // Nothing answered: a name that will not resolve, a timeout, a dropped
    // connection. Every verdict above is a response the gateway actually sent;
    // this is the absence of one, which is not the same thing as a refusal.
    return {
      status: 'unreachable',
      reason: error instanceof Error ? error.message : 'Access request failed.',
    };
  }
}
