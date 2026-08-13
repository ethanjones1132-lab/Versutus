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

export type GatewayManifestProvider = {
  id: string;
  label: string;
  basePath: string;
  models: string[];
  capabilities: { chat?: boolean; streaming?: boolean; [key: string]: boolean | undefined };
};

function isGatewayManifestProvider(value: unknown): value is GatewayManifestProvider {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.id === 'string' &&
    raw.id.length > 0 &&
    typeof raw.label === 'string' &&
    typeof raw.basePath === 'string' &&
    raw.basePath.length > 0 &&
    Array.isArray(raw.models) &&
    raw.models.every((m) => typeof m === 'string') &&
    typeof raw.capabilities === 'object' &&
    raw.capabilities !== null
  );
}

export type GatewayCapabilityField = {
  key: string;
  label: string;
  type: 'string' | 'string-list' | 'number' | 'boolean' | 'enum' | 'secret-ref';
  required?: boolean;
  options?: string[];
  default?: unknown;
  help?: string;
};

export type GatewayCapabilityKind = {
  id: string;
  label: string;
  family: string;
  configFields: GatewayCapabilityField[];
};

export type GatewayCapabilityCommand = {
  slash: string;
  description: string;
  method: string;
  danger: 'safe' | 'write' | 'destructive';
  params?: Record<string, unknown>;
};

export type GatewayCapabilityInstance = {
  id: string;
  kind: string;
  label: string;
  family: string;
  manifestEntry?: Record<string, unknown>;
  commands?: GatewayCapabilityCommand[];
};

function isGatewayCapabilityKind(value: unknown): value is GatewayCapabilityKind {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.id === 'string' &&
    raw.id.length > 0 &&
    typeof raw.label === 'string' &&
    typeof raw.family === 'string' &&
    raw.family.length > 0 &&
    Array.isArray(raw.configFields)
  );
}

function isGatewayCapabilityInstance(value: unknown): value is GatewayCapabilityInstance {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.id === 'string' &&
    raw.id.length > 0 &&
    typeof raw.kind === 'string' &&
    raw.kind.length > 0 &&
    typeof raw.label === 'string' &&
    typeof raw.family === 'string' &&
    raw.family.length > 0
  );
}

function isGatewayCapabilityCommand(value: unknown): value is GatewayCapabilityCommand {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.slash === 'string' &&
    raw.slash.startsWith('/') &&
    typeof raw.method === 'string' &&
    raw.method.length > 0 &&
    typeof raw.description === 'string' &&
    (raw.danger === 'safe' || raw.danger === 'write' || raw.danger === 'destructive')
  );
}

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
  providers?: GatewayManifestProvider[];
  capabilityKinds?: GatewayCapabilityKind[];
  capabilityInstances?: GatewayCapabilityInstance[];
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
 * Every well-formed provider a gate advertises. A malformed entry is dropped,
 * not thrown — one bad entry in an otherwise valid manifest shouldn't take
 * down identification for every other provider.
 */
export function manifestProviders(manifest: GatewayManifest): GatewayManifestProvider[] {
  if (!Array.isArray(manifest.providers)) return [];
  return manifest.providers.filter(isGatewayManifestProvider);
}

/**
 * Every well-formed capability kind a gate advertises. A malformed entry is
 * dropped, not thrown — same discipline as manifestProviders().
 */
export function manifestCapabilityKinds(manifest: GatewayManifest): GatewayCapabilityKind[] {
  if (!Array.isArray(manifest.capabilityKinds)) return [];
  return manifest.capabilityKinds.filter(isGatewayCapabilityKind);
}

/** Every well-formed configured capability instance a gate advertises. */
export function manifestCapabilityInstances(manifest: GatewayManifest): GatewayCapabilityInstance[] {
  if (!Array.isArray(manifest.capabilityInstances)) return [];
  return manifest.capabilityInstances.filter(isGatewayCapabilityInstance);
}

/**
 * Every well-formed command a gate's instances contribute, flattened across
 * instances. A malformed command is dropped so it can never reach the palette
 * as an entry that could only fail.
 */
export function manifestDynamicCommands(manifest: GatewayManifest): GatewayCapabilityCommand[] {
  return manifestCapabilityInstances(manifest).flatMap((instance) =>
    Array.isArray(instance.commands) ? instance.commands.filter(isGatewayCapabilityCommand) : [],
  );
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
