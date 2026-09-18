// ─── Gateway identification cascade ───────────────────────────────
// Identify any gateway regardless of origin:
//   1. beacon TXT kind (instant, no network)
//   2. Open Gateway Manifest (authoritative, custom gates)
//   3. Hermes fingerprint (/health + /v1/capabilities)
//   4. OpenClaw fingerprint (bounded WS probe expecting connect.challenge)
//   5. unknown (HTTP health OK, nothing else matches)
// See docs/portal-architecture.md §3.

import { httpToWsBase } from '@/lib/gateway/url';
import { isHostLookupFailure, withHostLookupRetry } from '@/lib/gateway/host-lookup';
import type { GatewayKind } from '@/lib/gateway/types';
import {
  fetchGatewayManifestWithLookupRetry,
  manifestAuthSchemes,
  manifestCapabilityList,
  manifestKindLabel,
  manifestProviders,
  manifestRequiresToken,
  type GatewayManifest,
  type GatewayManifestProvider,
} from '@/lib/portal/manifest';

export type GatewayIdentity = {
  kind: GatewayKind;
  /** Human label, e.g. 'Hermes', 'OpenClaw', 'Custom — mygate'. */
  kindLabel: string;
  /** Custom kind id from the manifest, when kind === 'custom'. */
  customKindId?: string;
  name?: string;
  version?: string;
  vendor?: string;
  manifest?: GatewayManifest;
  auth: {
    schemes: string[];
    requiresToken: boolean;
    grantPath?: string;
  };
  transportHint?: 'http' | 'ws';
  capabilities?: string[];
  /** Providers this gate advertises behind one manifest — see manifest.ts. */
  providers?: GatewayManifestProvider[];
  /** Where the identification came from (for diagnostics/UI). */
  source: 'beacon' | 'manifest' | 'probe-hermes' | 'probe-openclaw' | 'unknown';
  identifiedAt: number;
};

export type IdentifyGatewayOptions = {
  baseUrl: string;
  /** Kind advertised in the discovery beacon TXT (fast path). */
  beaconKind?: string;
  /** Skip the manifest fetch (e.g. already known to fail). */
  skipManifest?: boolean;
  /**
   * Tailnet IPv4s that can stand in for this gateway's hostname on a
   * MagicDNS miss — the configured or discovered addresses the caller holds
   * before any client exists. An https base never uses one (TLS keeps its
   * hostname).
   */
  alternateIpv4?: string[];
  timeoutMs?: number;
};

function mapKind(rawKind: string | undefined): { kind: GatewayKind; customKindId?: string } {
  const normalized = rawKind?.trim().toLowerCase();
  if (normalized === 'hermes') return { kind: 'hermes' };
  if (normalized === 'openclaw') return { kind: 'openclaw' };
  if (normalized) return { kind: 'custom', customKindId: rawKind?.trim() };
  return { kind: 'unknown' };
}

function identityFromManifest(manifest: GatewayManifest, baseUrl: string): GatewayIdentity {
  const { kind, customKindId } = mapKind(manifest.kind);
  return {
    kind,
    kindLabel: manifestKindLabel(manifest),
    customKindId,
    name: manifest.name,
    version: manifest.version,
    vendor: manifest.vendor,
    manifest,
    auth: {
      schemes: manifestAuthSchemes(manifest),
      requiresToken: manifestRequiresToken(manifest),
      grantPath: manifest.auth?.grantPath,
    },
    transportHint: manifest.transport?.primary === 'ws' ? 'ws' : 'http',
    capabilities: manifestCapabilityList(manifest),
    providers: manifestProviders(manifest),
    source: 'manifest',
    identifiedAt: Date.now(),
  };
}

/**
 * Identify a gateway at baseUrl. Never throws — resolves to a GatewayIdentity
 * with kind 'unknown' when nothing matches.
 */
export async function identifyGateway(options: IdentifyGatewayOptions): Promise<GatewayIdentity> {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 15_000;
  const started = Date.now();
  const alternateIpv4 = options.alternateIpv4 ?? [];

  // 1. Beacon fast path (no network).
  if (options.beaconKind) {
    const { kind, customKindId } = mapKind(options.beaconKind);
    if (kind !== 'unknown') {
      return {
        kind,
        kindLabel: kind === 'custom' && customKindId ? `Custom — ${customKindId}` : capitalize(kind),
        customKindId,
        auth: { schemes: [], requiresToken: kind !== 'openclaw', grantPath: undefined },
        transportHint: kind === 'openclaw' ? 'ws' : 'http',
        source: 'beacon',
        identifiedAt: Date.now(),
      };
    }
  }

  // 2. Manifest (authoritative for any custom gate that serves it). A host
  // lookup miss retries over the injected tailnet IPv4s — the same splice a
  // rescued manifest refresh walks — instead of silently skipping the read. A
  // served manifest forms the identity here; its advertised IPv4s then ride
  // that identity into the access handshake (portal/access.ts) as the
  // discovered tail for the next request.
  if (!options.skipManifest) {
    const manifest = await fetchGatewayManifestWithLookupRetry(baseUrl, alternateIpv4, Math.min(10_000, timeoutMs));
    if (manifest) return identityFromManifest(manifest, baseUrl);
  }

  const remaining = () => Math.max(1500, timeoutMs - (Date.now() - started));

  // 3. Hermes fingerprint: /health + /v1/capabilities.
  const hermes = await withHostLookupRetry(baseUrl, alternateIpv4, (candidate) =>
    probeHermes(candidate, Math.min(5000, remaining())),
  ).catch(() => null);
  if (hermes) return hermes;

  // 4. OpenClaw fingerprint: bounded WS probe expecting connect.challenge.
  const openclaw = await probeOpenClaw(baseUrl, Math.min(6000, remaining()));
  if (openclaw) return openclaw;

  // 5. Unknown — but record whether HTTP answers at all.
  const httpAlive = await withHostLookupRetry(baseUrl, alternateIpv4, (candidate) =>
    probeHttpAlive(candidate, Math.min(3000, remaining())),
  ).catch(() => false);
  return {
    kind: 'unknown',
    kindLabel: 'Unknown gateway',
    auth: { schemes: [], requiresToken: true, grantPath: undefined },
    transportHint: httpAlive ? 'http' : undefined,
    source: 'unknown',
    identifiedAt: Date.now(),
  };
}

// ─── Fingerprints ─────────────────────────────────────────────────

async function probeHermes(baseUrl: string, timeoutMs: number): Promise<GatewayIdentity | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const base = baseUrl.replace(/\/+$/, '');
  try {
    const healthResponse = await fetch(`${base}/health`, {
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    if (!healthResponse.ok) return null;
    const health = (await healthResponse.json().catch(() => null)) as
      | { status?: string; platform?: string; version?: string }
      | null;
    if (!health || typeof health.status !== 'string') return null;

    const platform = typeof health.platform === 'string' ? health.platform.toLowerCase() : '';
    // Hermes 0.18 advertises platform on /health. Prefer that over capabilities:
    // older probe required caps.runtime, which real hermes-agent does not send,
    // so every Hermes was mis-identified as "unknown".
    const healthSaysHermes = platform.includes('hermes');

    // Enrich from /v1/capabilities when available (optional; may require auth).
    let requiresToken = true;
    let capsHermes = false;
    try {
      const capsResponse = await fetch(`${base}/v1/capabilities`, {
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
      if (capsResponse.ok) {
        const caps = (await capsResponse.json().catch(() => null)) as
          | {
              object?: string;
              platform?: string;
              auth?: { type?: string; required?: boolean };
              runtime?: { mode?: string; tool_execution?: string; split_runtime?: boolean };
              features?: Record<string, unknown>;
              endpoints?: Record<string, unknown>;
            }
          | null;
        if (caps) {
          const objectName = typeof caps.object === 'string' ? caps.object.toLowerCase() : '';
          const capsPlatform = typeof caps.platform === 'string' ? caps.platform.toLowerCase() : '';
          const hasHermesFeatures =
            caps.features?.chat_completions === true || caps.features?.run_submission === true;
          const hasHermesEndpoints =
            caps.endpoints != null &&
            (caps.endpoints.chat_completions != null || caps.endpoints.runs != null);
          capsHermes =
            (typeof caps.runtime === 'object' && caps.runtime !== null) ||
            objectName.includes('hermes') ||
            capsPlatform.includes('hermes') ||
            hasHermesFeatures ||
            hasHermesEndpoints;
          if (caps.auth?.required === false) requiresToken = false;
        }
      }
    } catch (error) {
      // Capabilities are optional — but a lookup miss is worth retrying over
      // an IPv4, so let it reach the retry seam instead of swallowing it.
      if (isHostLookupFailure(error)) throw error;
    }

    if (!healthSaysHermes && !capsHermes) return null;

    return {
      kind: 'hermes',
      kindLabel: 'Hermes',
      name: health.platform ? `Hermes · ${health.platform}` : 'Hermes',
      version: health.version,
      auth: {
        schemes: ['bearer'],
        requiresToken,
        grantPath: undefined,
      },
      transportHint: 'http',
      capabilities: ['chat', 'runs', 'sessions', 'models', 'approvals'],
      source: 'probe-hermes',
      identifiedAt: Date.now(),
    };
  } catch (error) {
    // A host lookup miss re-throws so the retry seam can try the injected
    // tailnet IPv4s; any other failure is a definitive "not Hermes".
    if (isHostLookupFailure(error)) throw error;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function probeOpenClaw(baseUrl: string, timeoutMs: number): Promise<GatewayIdentity | null> {
  if (typeof globalThis.WebSocket !== 'function') return null;
  const wsUrl = `${httpToWsBase(baseUrl)}/openclaw`;

  return new Promise<GatewayIdentity | null>((resolve) => {
    let settled = false;
    let socket: WebSocket | null = null;

    const finish = (result: GatewayIdentity | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // ignore
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    try {
      socket = new WebSocket(wsUrl);
      socket.onopen = () => {
        // Waiting for connect.challenge — the gateway speaks first.
      };
      socket.onmessage = (event) => {
        try {
          const frame = JSON.parse(String(event.data)) as { type?: string; event?: string };
          if (frame.type === 'event' && frame.event === 'connect.challenge') {
            finish({
              kind: 'openclaw',
              kindLabel: 'OpenClaw',
              auth: { schemes: ['challenge-response'], requiresToken: false, grantPath: undefined },
              transportHint: 'ws',
              source: 'probe-openclaw',
              identifiedAt: Date.now(),
            });
          }
        } catch {
          // not JSON — not OpenClaw wire protocol
        }
      };
      socket.onerror = () => finish(null);
      socket.onclose = () => finish(null);
    } catch {
      finish(null);
    }
  });
}

async function probeHttpAlive(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/health`, { signal: controller.signal });
    return response.ok;
  } catch (error) {
    if (isHostLookupFailure(error)) throw error;
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
