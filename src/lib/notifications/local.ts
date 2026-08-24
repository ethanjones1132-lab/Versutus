// ─── Local notifications (ADR-0001) ───────────────────────────────
// The app fires these itself while its connection to the gateway is
// alive. True server-delivered push is deferred behind the Phase D
// relay; nothing here claims otherwise.

import * as Notifications from 'expo-notifications';
import { AppState } from 'react-native';

let permissionGranted = false;

/**
 * Identifier of the "gateway unreachable" notice this process last posted,
 * so recovery can retire exactly it. Cleared on dismissal.
 */
let gatewayDownNotificationId: string | null = null;

const GATEWAY_DOWN_TITLE = 'Gateway unreachable';

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

async function present(title: string, body: string, allowForeground = false): Promise<string | null> {
  if (isForegrounded() && !allowForeground) return null;
  if (!(await ensurePermission())) return null;
  try {
    return await Notifications.scheduleNotificationAsync({
      content: { title, body, sound: 'default' },
      trigger: null,
    });
  } catch {
    // best-effort: notification must never break the app flow
    return null;
  }
}

export async function notifyApprovalRequired(prompt: string): Promise<void> {
  const title = 'Approval required';
  const body = prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt;
  // No identifier to keep — these notices have no lifecycle beyond posting.
  await present(title, body);
}

export async function notifyRunComplete(title: string, body: string): Promise<void> {
  await present(title, body);
}

export async function notifyGatewayDown(host: string): Promise<void> {
  const id = await present(
    GATEWAY_DOWN_TITLE,
    `Lost connection to ${host}. Versutus will keep retrying.`,
  );
  // A null here means the notice was skipped (foregrounded, no permission, or
  // the schedule failed) — keep any identifier we already hold rather than
  // forgetting a notice that is still sitting in the tray.
  if (id) gatewayDownNotificationId = id;
}

/**
 * Retire the "gateway unreachable" notice once the gateway is back.
 *
 * Two paths, because either can be the live one: this process posted the
 * notice and still holds its identifier, or the app was restarted while the
 * notice sat in the tray and only the title identifies it now. Both are
 * best-effort — recovery must never fail because cleanup did.
 */
export async function dismissGatewayDown(): Promise<void> {
  const knownId = gatewayDownNotificationId;
  gatewayDownNotificationId = null;
  try {
    if (knownId) await Notifications.dismissNotificationAsync(knownId);
    const presented = await Notifications.getPresentedNotificationsAsync();
    await Promise.all(
      presented
        .filter((notification) => notification.request.content.title === GATEWAY_DOWN_TITLE)
        .map((notification) =>
          Notifications.dismissNotificationAsync(notification.request.identifier),
        ),
    );
  } catch {
    // best-effort: a stale tray entry is cosmetic, never fatal
  }
}
