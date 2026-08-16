import type { ProviderProfile, ProviderSnapshot } from '@/lib/gateway/provider-types';

export type Rpc = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;

/** Same shape the Gate enforces on instance ids (gate/core/cli-helpers.mjs). */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * A base URL is the API root the profile appends its own paths to. Pasting the
 * full chat endpoint is the obvious mistake — it turns the models lookup into
 * `<base>/chat/completions/models`, which 404s with nothing explaining why.
 */
export function normalizeBaseUrl(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return '';
  return trimmed
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/+$/, '');
}

export type CreateProviderInput = {
  id: string;
  label?: string;
  profile: ProviderProfile;
  /** Override for a self-hosted endpoint; defaults to the profile's own base URL. */
  baseUrl?: string;
};

/**
 * Build the v2 registration document from a profile choice. The Gate's schema
 * is exact and unforgiving, so assembling it here keeps every caller — screens,
 * tests, future surfaces — from having to know its shape.
 */
export function buildProviderRegistration(input: CreateProviderInput): Record<string, unknown> {
  if (!ID_PATTERN.test(input.id)) {
    throw new Error(
      `Provider id "${input.id}" is not valid — use lowercase letters, numbers and hyphens.`,
    );
  }
  const baseUrl = normalizeBaseUrl(input.baseUrl) || input.profile.defaultBaseUrl;
  if (!baseUrl) {
    throw new Error(`${input.profile.label} needs a base URL.`);
  }
  return {
    schemaVersion: 2,
    kind: 'provider',
    id: input.id,
    label: input.label?.trim() || input.id,
    providerType: input.profile.providerType,
    enabled: true,
    registration: {
      mode: input.profile.mode,
      protocol: input.profile.protocol,
      baseUrl,
      credentialRef: `provider/${input.id}/api-key`,
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 120000 },
  };
}

export function createProviderClient(request: Rpc) {
  return {
    listProfiles: async () => {
      const raw = await request<{ profiles?: ProviderProfile[] } | ProviderProfile[]>(
        'providers.profiles.list',
      );
      return Array.isArray(raw) ? raw : raw.profiles ?? [];
    },
    list: async () => {
      const raw = await request<{ providers?: ProviderSnapshot[] } | ProviderSnapshot[]>('providers.list');
      return Array.isArray(raw) ? raw : raw.providers ?? [];
    },
    get: (id: string) => request<ProviderSnapshot>('providers.get', { id }),
    // async so a rejected id surfaces as a rejected promise, not a synchronous
    // throw that a `.catch()` on the call site would miss.
    create: async (input: CreateProviderInput) =>
      request<{ ok: boolean }>('providers.create', buildProviderRegistration(input)),
    update: (id: string, patch: Record<string, unknown>) =>
      request<{ ok: boolean }>('providers.update', { id, ...patch }),
    check: (id: string) => request<ProviderSnapshot>('providers.health.check', { id }),
    refreshCatalog: (id: string) => request<ProviderSnapshot>('providers.catalog.refresh', { id }),
    setApiKey: (id: string, value: string) => request<{ ok: boolean }>('providers.auth.setApiKey', { id, value }),
    beginAuth: (id: string) => request('providers.auth.begin', { id }),
    disconnect: (id: string) => request('providers.auth.disconnect', { id }),
    remove: (id: string) => request('providers.delete', { id }),
  };
}
