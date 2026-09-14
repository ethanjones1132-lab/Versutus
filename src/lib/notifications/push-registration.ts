// ─── Expo push token registration with the Gate (Solution A2) ──────────────
// The app side of the relay: ask the platform for this device's Expo push
// token and hand it to the Gate over the paired-device grant, where
// `notifications.register` keys it by the grant's deviceId — never by anything
// the app supplies. Nothing here sends a notification; the Gate does, once the
// operator flips the per-device toggle (A5).
//
// The token is persisted only so a rotated one is noticed and written down; the
// Gate holds the authority on what is registered. Every failure — web, a
// missing permission, a throw from the native module — resolves to null and
// never reaches the connect path, so push setup can never stall a connection.

import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { secureKeyValueStorage } from '@/lib/storage/secure-key-value';

/**
 * Where this device's last-known Expo push token is kept. The token itself is
 * device-wide (one platform token per install), so it lives in one blob key;
 * which GATEWAY it was already registered with is tracked per scope beside it
 * by `loadRegisteredScope` / `markRegisteredScope`.
 */
export const STORE_KEY = 'versutus:expo-push-token:v1';

/**
 * The EAS project the token belongs to. `Constants.easConfig` carries it in a
 * build; the literal is the same project the plan pins, so a dev runtime that
 * cannot surface it still asks for the right token.
 */
const PROJECT_ID = '52545800-300a-4bbc-a2b9-7e412d9c217e';

/**
 * The same seam `client.rpcRequest` presents: the registration functions take
 * the client's method rather than the client, so a test hands them a stub.
 */
export type Rpc = {
  rpcRequest(method: string, params?: Record<string, unknown>): Promise<unknown>;
};

/** The Expo push token this device last persisted, or null. */
export async function loadStoredExpoPushToken(): Promise<string | null> {
  try {
    return await secureKeyValueStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
}

function resolvedProjectId(): string {
  return Constants.easConfig?.projectId ?? PROJECT_ID;
}

function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

/**
 * Obtain this device's Expo push token, persisting it when it has changed.
 *
 * Null is the honest answer on web (no tray), when the operator has not granted
 * notification permission, or when the native module throws — the connect path
 * that calls this must never see a rejection over a token that may simply not
 * exist yet.
 */
export async function obtainExpoPushToken(): Promise<string | null> {
  if (Platform.OS === 'web') return null;
  try {
    const permissions = await Notifications.getPermissionsAsync();
    if (!permissions.granted) return null;
    const result = await Notifications.getExpoPushTokenAsync({
      projectId: resolvedProjectId(),
    });
    const token = typeof result.data === 'string' && result.data.length > 0 ? result.data : null;
    if (!token) return null;
    const stored = await loadStoredExpoPushToken();
    if (stored !== token) await secureKeyValueStorage.setItem(STORE_KEY, token);
    return token;
  } catch {
    return null;
  }
}

/** Hand one token to the Gate under the paired device's own grant. */
export async function registerWithGate(rpc: Rpc, token: string): Promise<void> {
  await rpc.rpcRequest('notifications.register', {
    expoPushToken: token,
    platform: Platform.OS,
    timezone: deviceTimezone(),
  });
}

/** Tell the Gate to drop this device's token. */
export async function deregisterWithGate(rpc: Rpc): Promise<void> {
  await rpc.rpcRequest('notifications.deregister');
}

/**
 * The `versutus:push-registered:<gatewayId>` key: which gateway this device's
 * token has already been registered with and at what token value. Registration
 * is per gateway, not per device — two paired profiles each hold their own
 * registry row Gate-side, keyed by the grant's deviceId.
 */
const registeredScopeKey = (gatewayId: string) => `versutus:push-registered:${gatewayId}`;

/**
 * The token value this device already registered with the named gateway, or
 * null when none was recorded (or the record is unreadable — a lost skip
 * marker only means one honest re-register, never a wrong one).
 */
async function loadRegisteredScope(gatewayId: string): Promise<string | null> {
  try {
    return await secureKeyValueStorage.getItem(registeredScopeKey(gatewayId));
  } catch {
    return null;
  }
}

/** Note the token now registered with the named gateway. */
async function markRegisteredScope(gatewayId: string, token: string): Promise<void> {
  try {
    await secureKeyValueStorage.setItem(registeredScopeKey(gatewayId), token);
  } catch {
    // A lost record costs one redundant register on the next connect, not a
    // failure — the Gate's registry is idempotent on upsert.
  }
}

/**
 * Obtain the token and register it with the named gateway; a device with no
 * token asks for nothing, a token unchanged since the last register for THIS
 * gateway is skipped (A2's "re-register when the token changes"), and any
 * failure resolves — the connected edge never hears a rejection over push.
 */
export async function syncPushRegistration(rpc: Rpc, gatewayId: string): Promise<void> {
  const token = await obtainExpoPushToken();
  if (!token) return;
  const registered = await loadRegisteredScope(gatewayId);
  if (registered === token) return;
  try {
    await registerWithGate(rpc, token);
  } catch {
    // A refused register never reaches the connect path — and nothing is
    // marked, so the next connected transition honestly tries again.
    return;
  }
  await markRegisteredScope(gatewayId, token);
}
