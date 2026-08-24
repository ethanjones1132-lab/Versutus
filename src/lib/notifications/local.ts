// ─── Local notifications (ADR-0001) ───────────────────────────────
// The app fires these itself while its connection to the gateway is
// alive. True server-delivered push is deferred behind the Phase D
// relay; nothing here claims otherwise.

import * as Notifications from 'expo-notifications';
import { AppState } from 'react-native';

import {
  GATEWAY_DOWN_TITLE,
  gatewayDownNoticeData,
  isDownNoticeFor,
} from './gateway-down-notice';

let permissionGranted = false;

/**
 * Identifier of the "gateway unreachable" notice this process last posted,
 * keyed by the gateway it belongs to, so recovery can retire exactly the
 * notice for the gateway that actually answered. Clearing a key on dismissal
 * never forgets a sibling gateway's still-valid notice.
 */
const gatewayDownNotificationIds = new Map<string, string>();

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

async function present(
  title: string,
  body: string,
  allowForeground = false,
  data?: Record<string, unknown>,
): Promise<string | null> {
  if (isForegrounded() && !allowForeground) return null;
  if (!(await ensurePermission())) return null;
  try {
    return await Notifications.scheduleNotificationAsync({
      content: { title, body, sound: 'default', ...(data ? { data } : {}) },
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

/**
 * Post the "gateway unreachable" notice for one gateway and record its
 * identifier under that gateway's key. The gateway key travels in the
 * notification payload as well, so a process restarted while the notice sits
 * in the tray can still attribute it on dismissal.
 */
export async function notifyGatewayDown(gatewayKey: string, host: string): Promise<void> {
  const id = await present(
    GATEWAY_DOWN_TITLE,
    `Lost connection to ${host}. Versutus will keep retrying.`,
    undefined,
    gatewayDownNoticeData(gatewayKey),
  );
  // A null here means the notice was skipped (foregrounded, no permission, or
  // the schedule failed) — keep any identifier we already hold rather than
  // forgetting a notice that is still sitting in the tray.
  if (id) gatewayDownNotificationIds.set(gatewayKey, id);
}

/**
 * Retire the "gateway unreachable" notice for exactly the gateway that
 * answered — never for its still-down siblings.
 *
 * Two paths, because either can be the live one: this process posted the
 * notice and still holds its identifier, or the app was restarted while the
 * notice sat in the tray and only the payload (or, for legacy notices, the
 * title) identifies it now. Both are best-effort — recovery must never fail
 * because cleanup did.
 */
export async function dismissGatewayDown(gatewayKey: string): Promise<void> {
  const knownId = gatewayDownNotificationIds.get(gatewayKey);
  if (knownId) {
    gatewayDownNotificationIds.delete(gatewayKey);
    try {
      await Notifications.dismissNotificationAsync(knownId);
    } catch {
      // best-effort: a stale tray entry is cosmetic, never fatal
    }
  }
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    await Promise.all(
      presented
        // An expo Notification wraps the request (identifier + content) in a
        // `request` field; the matching helper operates on the request shape.
        .filter((notification) => isDownNoticeFor(notification.request, gatewayKey))
        .map((notification) =>
          Notifications.dismissNotificationAsync(notification.request.identifier),
        ),
    );
  } catch {
    // best-effort: a stale tray entry is cosmetic, never fatal
  }
}