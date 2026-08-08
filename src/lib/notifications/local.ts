// ─── Local notifications (ADR-0001) ───────────────────────────────
// The app fires these itself while its connection to the gateway is
// alive. True server-delivered push is deferred behind the Phase D
// relay; nothing here claims otherwise.

import * as Notifications from 'expo-notifications';
import { AppState } from 'react-native';

let permissionGranted = false;

async function ensurePermission(): Promise<boolean> {
  if (permissionGranted) return true;
  try {
    const settings = await Notifications.requestPermissionsAsync();
    permissionGranted = settings.granted;
    return permissionGranted;
  } catch {
    return false;
  }
}

function isForegrounded(): boolean {
  return AppState.currentState === 'active';
}

async function present(title: string, body: string, allowForeground = false): Promise<void> {
  if (isForegrounded() && !allowForeground) return;
  if (!(await ensurePermission())) return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title, body, sound: 'default' },
      trigger: null,
    });
  } catch {
    // best-effort: notification must never break the app flow
  }
}

export function notifyApprovalRequired(prompt: string): Promise<void> {
  const title = 'Approval required';
  const body = prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt;
  return present(title, body);
}

export function notifyRunComplete(title: string, body: string): Promise<void> {
  return present(title, body);
}

export function notifyGatewayDown(host: string): Promise<void> {
  return present('Gateway unreachable', `Lost connection to ${host}. Versutus will keep retrying.`);
}
