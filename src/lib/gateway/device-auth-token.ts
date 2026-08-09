import { secureKeyValueStorage } from '@/lib/storage/secure-key-value';

type DeviceAuthToken = {
  token: string;
  role: string;
  scopes: string[];
  updatedAtMs: number;
};

type DeviceAuthStore = {
  version: 1;
  deviceId: string;
  tokens: Record<string, DeviceAuthToken>;
};

const DEVICE_AUTH_TOKEN_KEY = 'versutus:device-auth-token:v1';

function normalizeScopes(scopes: unknown): string[] {
  if (!Array.isArray(scopes)) return [];
  return [...new Set(scopes.filter((scope): scope is string => typeof scope === 'string' && !!scope.trim()))];
}

function parseStore(raw: string | null, deviceId: string): DeviceAuthStore | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DeviceAuthStore;
    if (parsed.version !== 1 || parsed.deviceId !== deviceId || typeof parsed.tokens !== 'object') return null;
    return {
      version: 1,
      deviceId,
      tokens: Object.fromEntries(
        Object.entries(parsed.tokens ?? {}).flatMap(([role, value]) => {
          if (!value || typeof value.token !== 'string' || !value.token.trim()) return [];
          return [
            [
              role,
              {
                token: value.token,
                role: value.role || role,
                scopes: normalizeScopes(value.scopes),
                updatedAtMs: typeof value.updatedAtMs === 'number' ? value.updatedAtMs : 0,
              },
            ],
          ];
        }),
      ),
    };
  } catch {
    return null;
  }
}

async function readRawTokenStore(): Promise<string | null> {
  return secureKeyValueStorage.getItem(DEVICE_AUTH_TOKEN_KEY);
}

async function writeRawTokenStore(value: string | null): Promise<void> {
  if (value === null) await secureKeyValueStorage.removeItem(DEVICE_AUTH_TOKEN_KEY);
  else await secureKeyValueStorage.setItem(DEVICE_AUTH_TOKEN_KEY, value);
}

export async function loadDeviceAuthToken(
  deviceId: string,
  role: string,
): Promise<DeviceAuthToken | null> {
  const store = parseStore(await readRawTokenStore(), deviceId);
  return store?.tokens[role] ?? null;
}

export async function saveDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  token: string;
  scopes?: string[];
}): Promise<void> {
  const token = params.token.trim();
  if (!token) return;

  const existing = parseStore(await readRawTokenStore(), params.deviceId);
  const store: DeviceAuthStore = existing ?? {
    version: 1,
    deviceId: params.deviceId,
    tokens: {},
  };

  store.tokens[params.role] = {
    token,
    role: params.role,
    scopes: normalizeScopes(params.scopes),
    updatedAtMs: Date.now(),
  };

  await writeRawTokenStore(JSON.stringify(store));
}

export async function clearDeviceAuthToken(deviceId: string, role: string): Promise<void> {
  const store = parseStore(await readRawTokenStore(), deviceId);
  if (!store?.tokens[role]) return;

  delete store.tokens[role];
  if (Object.keys(store.tokens).length === 0) {
    await writeRawTokenStore(null);
    return;
  }

  await writeRawTokenStore(JSON.stringify(store));
}
