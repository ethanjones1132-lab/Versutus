// ─── Open Gateway Manifest (/.well-known/gateway.json) ────────────
// The universal contract that makes custom gates first-class citizens
// of the portal. See docs/portal-architecture.md §2.

export const GATEWAY_MANIFEST_PATH = '/.well-known/gateway.json';
export const GATEWAY_MANIFEST_SPEC = 'versutus-gateway/v1';

export type GatewayManifestAuth = {
  /** How the gate answers access requests. */
  schemes: ('bearer' | 'challenge-response' | 'none' | string)[];
  /** Optional universal access-request endpoint (see portal/access.ts). */
  grantPath?: string;
  /** Optional challenge endpoint for challenge-response schemes. */
  challengePath?: string;
};

export type GatewayManifest = {
  manifest: string;
  /** 'hermes' | 'openclaw' | custom kind id (any other string → 'custom'). */
  kind: string;
  name?: string;
  version?: string;
  vendor?: string;
  auth?: GatewayManifestAuth;
  transport?: {
    primary?: 'http' | 'ws';
    /** WS path when primary transport is 'ws' (e.g. '/openclaw'). */
    basePath?: string;
  };
  capabilities?: {
    chat?: boolean;
    runs?: boolean;
    terminal?: boolean;
    sessions?: boolean;
    models?: boolean;
    approvals?: boolean;
    [key: string]: boolean | undefined;
  };
  endpoints?: Record<string, string>;
};

export function isGatewayManifest(value: unknown): value is GatewayManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (typeof raw.manifest !== 'string' || !raw.manifest.startsWith('versutus-gateway/')) return false;
  if (typeof raw.kind !== 'string' || !raw.kind.trim()) return false;
  return true;
}

export function manifestKindLabel(manifest: GatewayManifest): string {
  const kind = manifest.kind.trim().toLowerCase();
  if (kind === 'hermes') return 'Hermes';
  if (kind === 'openclaw') return 'OpenClaw';
  if (!kind) return 'Custom gateway';
  const raw = manifest.kind.trim();
  const short = raw.length <= 24 ? raw : `${raw.slice(0, 24)}…`;
  return `Custom — ${short}`;
}

export function manifestAuthSchemes(manifest: GatewayManifest): string[] {
  const schemes = manifest.auth?.schemes;
  if (!Array.isArray(schemes)) return [];
  return [...new Set(schemes.filter((item): item is string => typeof item === 'string' && !!item.trim()))];
}

export function manifestRequiresToken(manifest: GatewayManifest): boolean {
  const schemes = manifestAuthSchemes(manifest);
  if (schemes.length === 0) return false;
  return schemes.includes('bearer') || schemes.includes('challenge-response');
}

export function manifestCapabilityList(manifest: GatewayManifest): string[] {
  const caps = manifest.capabilities;
  if (!caps || typeof caps !== 'object') return [];
  return Object.entries(caps)
    .filter(([, enabled]) => enabled === true)
    .map(([name]) => name);
}

/**
 * Fetch and validate an Open Gateway Manifest. Resolves null when the
 * gateway does not serve one (the caller falls back to fingerprinting).
 */
export async function fetchGatewayManifest(
  baseUrl: string,
  timeoutMs = 4000,
): Promise<GatewayManifest | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}${GATEWAY_MANIFEST_PATH}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const text = await response.text();
    try {
      const parsed: unknown = JSON.parse(text);
      return isGatewayManifest(parsed) ? parsed : null;
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
