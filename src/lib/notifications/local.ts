// ─── Local notifications (ADR-0001) ───────────────────────────────
// The app fires these itself while its connection to the gateway is
// alive. True server-delivered push is deferred behind the Phase D
// relay; nothing here claims otherwise.

import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';

import {
  approvalDecisionCopy,
  approvalRefusalCopy,
  type ApprovalDecision,
  type ApprovalRefusalReason,
} from './approval-action';
import { botReplyNoticeCopy, type BotReplyNoticeReason } from './bot-reply';
import {
  GATEWAY_DOWN_TITLE,
  gatewayDownNoticeData,
  isDownNoticeFor,
} from './gateway-down-notice';
import { APPROVAL_CATEGORY_ID, APPROVAL_NOTICE_DATA_KIND } from './categories';
import type { RunProgressNotice } from './run-progress';
import { RUN_NOTICE_DATA_KIND } from './tap-route';

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

/**
 * The one gate every notice goes through: an app in the foreground draws
 * nothing unless it was asked to, and nothing is drawn without permission.
 *
 * `androidNotice` is §7's own shape and nothing else's — a notice posted under
 * a run's identifier, on a run's channel. On Android the identifier IS the
 * notification's tag (ExpoPresentationDelegate.kt:108-112), so re-posting one
 * replaces what is already in the tray instead of stacking a second notice; a
 * channel-carrying trigger is that platform's immediate trigger on the channel
 * it names (ChannelAwareTriggerInput, notifications.md:1908). Every other
 * notice passes no `androidNotice` and keeps the request shape it always had.
 */
async function present(
  title: string,
  body: string,
  allowForeground = false,
  data?: Record<string, unknown>,
  categoryIdentifier?: string,
  androidNotice?: { identifier: string; channelId: string },
): Promise<string | null> {
  if (isForegrounded() && !allowForeground) return null;
  if (!(await ensurePermission())) return null;
  try {
    return await Notifications.scheduleNotificationAsync({
      ...(androidNotice ? { identifier: androidNotice.identifier } : {}),
      content: {
        title,
        body,
        sound: 'default',
        ...(data ? { data } : {}),
        ...(categoryIdentifier ? { categoryIdentifier } : {}),
      },
      trigger: androidNotice ? { channelId: androidNotice.channelId } : null,
    });
  } catch {
    // best-effort: notification must never break the app flow
    return null;
  }
}

/**
 * Post the approval request. The payload names the run awaiting the decision
 * and the gateway that issued it, so an Approve / Deny action can only resolve
 * this app's own pending approval, and the category supplies the buttons.
 */
export async function notifyApprovalRequired(
  prompt: string,
  runId: string,
  gatewayKey: string,
): Promise<void> {
  const title = 'Approval required';
  const body = prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt;
  // No identifier to keep — these notices have no lifecycle beyond posting.
  await present(
    title,
    body,
    undefined,
    { kind: APPROVAL_NOTICE_DATA_KIND, runId, gatewayKey },
    APPROVAL_CATEGORY_ID,
  );
}

/**
 * Post the notice that a run this app drove has settled. The payload names the
 * run, so a tap knows which one the notice was about rather than only that
 * something finished — the same `kind`/id shape a tap routes on (routeForTap)
 * and the same shape true push must supply later (Solution A5).
 *
 * The copy still says only what settled ("Run complete", "Run finished"), and
 * the id is the run's own: a payload that names no run is refused by the tap
 * router rather than guessed at.
 */
export async function notifyRunComplete(
  title: string,
  body: string,
  runId: string,
): Promise<void> {
  await present(title, body, undefined, { kind: RUN_NOTICE_DATA_KIND, runId });
}

/**
 * Post the fail-closed notice for an Approve / Deny action that could not be
 * applied. The reason picks the copy: only a decision that could not reach a run
 * this app is driving may say the gateway was unreachable; a notice with nothing
 * waiting behind it says that instead, and claims nothing about the gateway. The
 * approval (if there is one) stays pending for the operator to decide in the
 * app, and no refusal copy claims the run was decided or that the gateway ran
 * anything.
 */
export async function notifyApprovalRefused(reason: ApprovalRefusalReason): Promise<void> {
  const copy = approvalRefusalCopy(reason);
  await present(copy.title, copy.body);
}

/**
 * Post the follow-up for a decision that LANDED — the acknowledgement the
 * operator's Approve / Deny asked for once the resolve has gone through and the
 * run is under way or stopping. The decision picks the copy, and it names only
 * what the decision asks of the run: what carries it to the gateway is the
 * driver's own report, so the notice never says the gateway accepted it.
 *
 * No payload and no category, on purpose: there is nothing left to decide, so a
 * tap on this notice is an ordinary tap (routeForTap reads no kind), and it
 * never wears a second set of buttons.
 */
export async function notifyApprovalDecided(decision: ApprovalDecision): Promise<void> {
  const copy = approvalDecisionCopy(decision);
  await present(copy.title, copy.body);
}

/**
 * Post the follow-up for a reply typed on a bot-message notice that did not go
 * out. The reason picks the copy: a reply the app had to park in the durable
 * offline outbox says it is saved and waiting on a connection, and a reply
 * whose Bot Chat could not be opened says nothing was sent. Neither claims the
 * Bot received anything — the reply's own words are the only text involved.
 */
export async function notifyBotReplyNotSent(reason: BotReplyNoticeReason): Promise<void> {
  const copy = botReplyNoticeCopy(reason);
  await present(copy.title, copy.body);
}

/**
 * Post the notice for a reply tap whose session could not be opened. A
 * push-delivered session id can be stale by the time the notice is tapped —
 * deleted or expired server-side in the meantime — and the open-by-id read
 * (session-open-by-id.ts) refuses to switch on a missing id. So the miss is
 * named rather than swallowed, and the message arrives already whole
 * (openSessionByIdFailureText names the id it was about).
 */
export async function notifySessionOpenFailed(message: string): Promise<void> {
  await present('Session not opened', message);
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

/**
 * The Android channel every run-progress notice is posted on. §7 asks for a
 * dedicated low-importance one so a long run's running commentary never beeps
 * or peeks: Android decides both from the channel, not from the request.
 */
export const RUN_PROGRESS_CHANNEL_ID = 'run-progress';

/** Whether this process has already asked the phone for the channel above. */
let runProgressChannelReady = false;

/**
 * Create the low-importance channel, once per process.
 *
 * After creation the platform lets a channel be re-named and re-described but
 * never re-ranked, so asking again per notice would buy a native round trip and
 * nothing else. A refusal is not remembered as done: the notice below is worth
 * posting whether or not this landed, and the next one retries.
 */
async function ensureRunProgressChannel(): Promise<void> {
  if (runProgressChannelReady) return;
  try {
    await Notifications.setNotificationChannelAsync(RUN_PROGRESS_CHANNEL_ID, {
      name: 'Run progress',
      importance: Notifications.AndroidImportance.LOW,
    });
    runProgressChannelReady = true;
  } catch {
    // best-effort: a notice posted without its channel is still a notice
  }
}

/**
 * The Android channels a relayed notice is posted on (Solution A3). An approval
 * is the one that must reach the operator, so it is HIGH; a completed reply and
 * a routine result are the ordinary DEFAULT. The ids are the same ones the Gate
 * names in a payload's `channelId`, so a notice lands where its kind belongs.
 */
export const APPROVALS_CHANNEL_ID = 'approvals';
export const MODEL_REPLIES_CHANNEL_ID = 'model-replies';
export const ROUTINE_RESULTS_CHANNEL_ID = 'routine-results';

/** Whether this process has already asked the phone for the relay channels. */
let relayChannelsReady = false;

/**
 * Create the three relay channels, once per process — the same reasoning as the
 * run-progress channel: a channel's rank is fixed at creation, so re-asking buys
 * a native round trip and nothing else, and a refusal is not remembered as done
 * so the next boot retries.
 */
export async function ensurePushChannels(): Promise<void> {
  if (relayChannelsReady) return;
  try {
    await Notifications.setNotificationChannelAsync(APPROVALS_CHANNEL_ID, {
      name: 'Approvals',
      importance: Notifications.AndroidImportance.HIGH,
    });
    await Notifications.setNotificationChannelAsync(MODEL_REPLIES_CHANNEL_ID, {
      name: 'Model replies',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
    await Notifications.setNotificationChannelAsync(ROUTINE_RESULTS_CHANNEL_ID, {
      name: 'Routine results',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
    relayChannelsReady = true;
  } catch {
    // best-effort: a notice posted without its channel is still a notice
  }
}

/** Whether this process has already installed the foreground display policy. */
let foregroundHandlerInstalled = false;

/**
 * Draw nothing while the app is in the foreground: the operator is already
 * looking at the stream a relayed notice would announce. Background and killed
 * still present. This is display policy, not a second router — a tap still goes
 * through the existing response listener.
 */
export function installForegroundNotificationHandler(): void {
  if (foregroundHandlerInstalled) return;
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => {
        const active = AppState.currentState === 'active';
        return {
          shouldShowBanner: !active,
          shouldShowList: !active,
          shouldPlaySound: !active,
          shouldSetBadge: false,
        };
      },
    });
    foregroundHandlerInstalled = true;
  } catch {
    // best-effort: a platform without the handler still presents what it can
  }
}

/**
 * Post one run's progress notice (§7's ongoing notice, item 7a's copy).
 *
 * The identifier is the run's own, so every update for that run REPLACES the
 * notice already in the tray rather than adding another, and one string retires
 * exactly that notice when the run settles. The payload is the fold's, so a tap
 * routes to the run the notice was about.
 *
 * Android's alone: iOS has no equivalent in this slice (its Live Activity is a
 * later item) and the web build has no tray at all, so neither is posted to nor
 * channel-created for. Whether a notice is drawn at all is still the shipped
 * gate's call — `present` refuses while the app is foregrounded, where the
 * operator already has the run card in front of them.
 *
 * A `retire` never reaches here: that arm is `dismissRunProgress`'s, because a
 * run's ending is `notifyRunComplete`'s to say, not this notice's.
 */
export async function notifyRunProgress(
  notice: Extract<RunProgressNotice, { verb: 'update' }>,
): Promise<void> {
  if (Platform.OS !== 'android') return;
  // Before the notice: the trigger below names this channel, and a post that
  // overtook its channel would land on the app's default one.
  await ensureRunProgressChannel();
  await present(notice.title, notice.body, undefined, notice.data, undefined, {
    identifier: notice.identifier,
    channelId: RUN_PROGRESS_CHANNEL_ID,
  });
}

/**
 * Retire one run's progress notice, under the identifier its updates were
 * posted with. Best-effort, like every other dismissal here: what settles a run
 * is the run settling, never the tray.
 */
export async function dismissRunProgress(identifier: string): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.dismissNotificationAsync(identifier);
  } catch {
    // best-effort: a stale tray entry is cosmetic, never fatal
  }
}