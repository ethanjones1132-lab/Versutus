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

import { loadOrCreateDeviceIdentity } from '@/lib/gateway/device-identity';
import { secureKeyValueStorage } from '@/lib/storage/secure-key-value';
import { registerWidgetPushTask } from '@/lib/widget/widget-push-task';

/** Where this device's last-known Expo push token is kept. */
const STORE_KEY = 'versutus:expo-push-token:v1';

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
/**
 * This device's stable id for the Gate's push rows.
 *
 * A paired device grant already names the device, and the Gate ignores this
 * for it. A phone connected with the Gate's bootstrap token has no grant, so
 * the Gate refused every notifications.* call 403 pairing_required — and push
 * could never reach the phone, however often notifications were allowed
 * (2026-09-16). The Gate files a bootstrap caller's row under this id in its
 * own namespace. An unreadable identity sends nothing rather than failing.
 */
export async function pushDeviceParams(): Promise<{ deviceId?: string }> {
  try {
    const { deviceId } = await loadOrCreateDeviceIdentity();
    return deviceId ? { deviceId } : {};
  } catch {
    return {};
  }
}

export async function registerWithGate(rpc: Rpc, token: string): Promise<void> {
  await rpc.rpcRequest('notifications.register', {
    expoPushToken: token,
    platform: Platform.OS,
    timezone: deviceTimezone(),
    ...(await pushDeviceParams()),
  });
}

/** Tell the Gate to drop this device's token. */
export async function deregisterWithGate(rpc: Rpc): Promise<void> {
  await rpc.rpcRequest('notifications.deregister', await pushDeviceParams());
}

/** Obtain the token and register it; a device with no token asks for nothing. */
export async function syncPushRegistration(rpc: Rpc): Promise<void> {
  // The background widget task is registered before the token question: a
  // device that has not granted notification permission still gets data-only
  // pushes into the widget. A registration that fails keeps the timer refresh.
  try {
    await registerWidgetPushTask();
  } catch {
    // Ignore: the six-hourly worker still rolls the stamp over.
  }
  const token = await obtainExpoPushToken();
  if (!token) return;
  // Registration must never break the connect path that calls this: a Gate
  // that refuses the RPC (unpaired grant, older build) just means no relay.
  try {
    await registerWithGate(rpc, token);
  } catch {
    // Swallowed by design — the next connect retries.
  }
}
