// ─── Universal access request ─────────────────────────────────────
// "Identify, then request access" — one handshake, per-kind dialect.
// See docs/portal-architecture.md §4.
//
// Result contract:
//   granted           → token returned (stored on the profile)
//   pending-approval  → gateway-side approval required (OpenClaw pairing)
//   token-required    → user must supply a token (Hermes API key today)
//   denied            → gateway refused

import { httpToWsBase } from '@/lib/gateway/url';
import { loadOrCreateDeviceIdentity, signDevicePayload } from '@/lib/gateway/device-identity';
import { OpenClawGatewayClient } from '@/lib/gateway/openclaw-client';
import type { GatewayHelloOk, PairingDetails } from '@/lib/gateway/types';
import { GATEWAY_MANIFEST_SPEC } from '@/lib/portal/manifest';
import type { GatewayIdentity } from '@/lib/portal/identify';

export type AccessRequestResult =
  | { status: 'granted'; token: string; role?: string; scopes?: string[] }
  | { status: 'pending-approval'; requestId?: string; hint?: string }
  | { status: 'token-required'; hint?: string }
  | { status: 'denied'; reason: string };

export type RequestGatewayAccessOptions = {
  baseUrl: string;
  identity: GatewayIdentity;
  /** Existing setup token (used as the signature token for OpenClaw). */
  token?: string;
  role?: string;
  scopes?: string[];
  timeoutMs?: number;
};

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

async function requestOpenClawAccess(options: RequestGatewayAccessOptions): Promise<AccessRequestResult> {
  const wsUrl = `${httpToWsBase(options.baseUrl)}/openclaw`;
  const profile = {
    id: 'access-probe',
    name: 'Access probe',
    url: wsUrl,
    token: options.token,
    createdAt: Date.now(),
  };

  return new Promise<AccessRequestResult>((resolve) => {
    let settled = false;
    let client: OpenClawGatewayClient | null = null;

    const finish = (result: AccessRequestResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client?.disconnect();
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ status: 'denied', reason: 'OpenClaw gateway did not answer the access request in time.' }),
      options.timeoutMs ?? 15000,
    );

    client = new OpenClawGatewayClient(profile, {
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
        finish({ status: 'denied', reason: message });
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
  try {
    const identity = await loadOrCreateDeviceIdentity();
    const signedAtMs = Date.now();
    const role = options.role ?? 'operator';
    const scopes = options.scopes ?? DEFAULT_SCOPES;
    const payload = [
      'v4',
      identity.deviceId,
      CLIENT_ID,
      role,
      scopes.join(','),
      String(signedAtMs),
    ].join('|');
    const signature = await signDevicePayload(identity, payload);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10000);

    try {
      const response = await fetch(`${baseUrl}${grantPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          manifest: GATEWAY_MANIFEST_SPEC,
          device: {
            id: identity.deviceId,
            publicKey: identity.publicKeyB64Url,
            clientId: CLIENT_ID,
            clientMode: CLIENT_MODE,
          },
          role,
          scopes,
          signedAtMs,
          signature,
          client: { name: 'Versutus', version: '1.0.0', platform: 'mobile' },
        }),
      });

      if (response.status === 404 || response.status === 405) {
        return { status: 'token-required', hint: 'This gateway does not serve universal access requests. Supply its token.' };
      }

      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      const status = typeof body?.status === 'string' ? body.status : undefined;
      if (response.ok && status === 'granted' && typeof body?.token === 'string') {
        return {
          status: 'granted',
          token: body.token,
          role: typeof body.role === 'string' ? body.role : undefined,
          scopes: Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === 'string') : undefined,
        };
      }
      if (response.status === 202 || status === 'pending') {
        return {
          status: 'pending-approval',
          requestId: typeof body?.requestId === 'string' ? body.requestId : undefined,
          hint: 'Access request sent — approve it on the gateway.',
        };
      }
      if (status === 'token-required') {
        return { status: 'token-required', hint: typeof body?.hint === 'string' ? body.hint : undefined };
      }
      if (response.status === 403 || status === 'denied') {
        return {
          status: 'denied',
          reason: typeof body?.reason === 'string' ? body.reason : 'The gateway denied the access request.',
        };
      }
      return { status: 'denied', reason: `Unexpected access response (HTTP ${response.status}).` };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return {
      status: 'denied',
      reason: error instanceof Error ? error.message : 'Access request failed.',
    };
  }
}
