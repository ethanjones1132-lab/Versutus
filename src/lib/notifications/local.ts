// ─── Local notifications (ADR-0001) ───────────────────────────────
// The app fires these itself only while its connection to the Gateway is
// alive. They do not deliver new Gateway events after that connection is lost.
// True push is delivered separately by the Gate relay via the Expo Push Service.

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
import {
  RUN_PROGRESS_NOTICE_PREFIX,
  runProgressNoticeIdentifier,
  type RunProgressNotice,
} from './run-progress';
import { RUN_NOTICE_DATA_KIND } from './tap-route';

let permissionGranted = false;

/**
 * How long a refusal is remembered before the phone is read again.
 *
 * A denied permission is settled until the operator changes it in Settings, so
 * re-reading it per notice buys a native round trip per notice and nothing
 * else. Ten minutes is short enough that granting it in Settings and coming
 * back to the app is not a restart's work, and long enough to cover the run
 * that posted the notice.
 */
const PERMISSION_DENIAL_TTL_MS = 10 * 60 * 1000;

/** Epoch ms until which this process takes the phone's refusal as final. */
let permissionDeniedUntil = 0;

/**
 * Identifier of the "gateway unreachable" notice this process last posted,
 * keyed by the gateway it belongs to, so recovery can retire exactly the
 * notice for the gateway that actually answered. Clearing a key on dismissal
 * never forgets a sibling gateway's still-valid notice.
 */
const gatewayDownNotificationIds = new Map<string, string>();

/**
 * Whether the phone has already refused, as this process last read it.
 */
function denialRemembered(): boolean {
  return permissionDeniedUntil > Date.now();
}

function rememberDenial(): void {
  permissionDeniedUntil = Date.now() + PERMISSION_DENIAL_TTL_MS;
}

/**
 * The one permission answer this process is waiting on, so concurrent callers
 * share a single evaluation: N notices folded in the same tick (a re-arm fanning
 * out over every routine) would otherwise each read the phone and each ask it
 * for the dialog, all before the first answer had set the cache. Cleared as
 * soon as the evaluation settles, so the next caller starts from the cached
 * grant, the remembered refusal, or a fresh read.
 */
let permissionCheckInFlight: Promise<boolean> | null = null;

/**
 * Whether a notice may be drawn, asking the phone only when asking can work.
 *
 * This used to cache `granted === true` and call `requestPermissionsAsync()` on
 * every notice otherwise, so a refusal re-asked for every single run — and did
 * so from the backgrounded state most notices are posted in, where Android 13+
 * cannot show the dialog at all. The phone is now read first: a grant is
 * cached, a refusal is remembered for {@link PERMISSION_DENIAL_TTL_MS} without a
 * re-ask, and the dialog is requested only from an undetermined state while the
 * app is in the foreground, which is the one place it can be shown. Best-effort
 * throughout — a notice is never worth an exception.
 *
 * Shared with the scheduled routine notices (routine-sync.ts), which kept a
 * private copy of the older asking gate and asked once per routine per
 * re-arm. One gate, one answer, for every poster on the phone.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (permissionGranted) return true;
  if (denialRemembered()) return false;
  if (permissionCheckInFlight) return permissionCheckInFlight;
  const check = readPermission();
  permissionCheckInFlight = check;
  try {
    return await check;
  } finally {
    if (permissionCheckInFlight === check) permissionCheckInFlight = null;
  }
}

async function readPermission(): Promise<boolean> {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) {
      permissionGranted = true;
      return true;
    }
    if (current.status === 'denied' || current.canAskAgain === false) {
      rememberDenial();
      return false;
    }
    // Undetermined, so the phone would still answer a dialog — but only a
    // foregrounded app can be shown one. A notice that arrives while the app is
    // pocketed waits for the next foregrounded one rather than asking into
    // the void.
    if (!isForegrounded()) return false;
    const requested = await Notifications.requestPermissionsAsync();
    permissionGranted = requested.granted;
    if (!requested.granted) rememberDenial();
    return permissionGranted;
  } catch {
    return false;
  }
}

function isForegrounded(): boolean {
  return AppState.currentState === 'active';
}

/**
 * The `data` key that marks a notice `present` was told to draw even while the
 * app is up. On Android the handler installed below is the layer that actually
 * decides presentation, so `allowForeground` has to travel in the payload to
 * reach it — a boolean parameter never gets that far.
 */
export const FOREGROUND_NOTICE_DATA_KEY = 'versutusForegroundNotice';

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
  if (!(await ensureNotificationPermission())) return null;
  // The foreground opt-in has to ride the payload: the notification handler is
  // the layer that decides Android presentation, and it only sees content.
  const noticeData = allowForeground
    ? { ...(data ?? {}), [FOREGROUND_NOTICE_DATA_KEY]: true }
    : data;
  try {
    return await Notifications.scheduleNotificationAsync({
      ...(androidNotice ? { identifier: androidNotice.identifier } : {}),
      content: {
        title,
        body,
        sound: 'default',
        ...(noticeData ? { data: noticeData } : {}),
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
 *
 * Drawn while the app is up, on purpose: the Reply action that leads here
 * foregrounds the app to open the Bot Chat, so the ordinary foreground refusal
 * would swallow the one notice that tells the operator their words went
 * nowhere — the failure is only ever heard by the person holding the phone.
 */
export async function notifyBotReplyNotSent(reason: BotReplyNoticeReason): Promise<void> {
  const copy = botReplyNoticeCopy(reason);
  await present(copy.title, copy.body, true);
}

/**
 * Post the notice for a reply tap whose session could not be opened. A
 * push-delivered session id can be stale by the time the notice is tapped —
 * deleted or expired server-side in the meantime — and the open-by-id read
 * (session-open-by-id.ts) refuses to switch on a missing id. So the miss is
 * named rather than swallowed, and the message arrives already whole
 * (openSessionByIdFailureText names the id it was about).
 *
 * Drawn while the app is up for the same reason as the reply above: the tap
 * that reached this is the tap that foregrounded the app, so refusing to draw
 * here is refusing to draw the only copy the operator will ever get.
 */
export async function notifySessionOpenFailed(message: string): Promise<void> {
  await present('Session not opened', message, true);
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
 *
 * A notice `present` posted with `allowForeground` carries
 * {@link FOREGROUND_NOTICE_DATA_KEY}, and is the one exception: without it the
 * handler below would veto the "your words went nowhere" notices one layer
 * under the app's own gate, and the operator would never see them. This is the
 * only way to reach the handler, which sees the payload and nothing else.
 */
export function installForegroundNotificationHandler(): void {
  if (foregroundHandlerInstalled) return;
  try {
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const optedIn =
          notification?.request?.content?.data?.[FOREGROUND_NOTICE_DATA_KEY] === true;
        const active = AppState.currentState === 'active' && !optedIn;
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
 * The shortest gap between two tray posts for the SAME run, and why it exists.
 *
 * Every run event re-folds §7's notice (the driver is the run rows), so a long
 * run streaming tool output asked the phone to draw, rebuild and notify once per
 * event — for a tray entry whose text changes only every few seconds. Five
 * seconds bounds that to what a locked screen can usefully show, and the copy
 * the window posts is the LATEST one (trailing), so a throttled post never
 * leaves the tray behind the run.
 */
const RUN_PROGRESS_THROTTLE_MS = 5_000;

type RunProgressThrottle = {
  /** When the last post for this identifier went out. */
  lastPostedAt: number;
  /** The newest state the throttle window is holding, posted when it opens. */
  pending?: Extract<RunProgressNotice, { verb: 'update' }>;
  /** The one-shot that posts `pending`, if the window is still open. */
  timer?: ReturnType<typeof setTimeout>;
};

const runProgressThrottles = new Map<string, RunProgressThrottle>();

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
 * At most one post per run per {@link RUN_PROGRESS_THROTTLE_MS}, trailing: the
 * first post of a run is never delayed, a post inside the window is held as the
 * window's newest state, and the ending is never this notice's to say (a
 * `retire` is `dismissRunProgress`'s). The throttle lives here, on the poster,
 * so it covers every caller rather than one call site.
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
  await throttleRunProgress(notice);
}

async function drawRunProgress(
  notice: Extract<RunProgressNotice, { verb: 'update' }>,
): Promise<void> {
  await present(notice.title, notice.body, undefined, notice.data, undefined, {
    identifier: notice.identifier,
    channelId: RUN_PROGRESS_CHANNEL_ID,
  });
}

/**
 * Ask for one update, coalescing to at most one post per throttle window.
 *
 * Outside the window the state is drawn now and becomes the window's baseline.
 * Inside it, the state becomes the window's newest — which the open window's
 * timer posts, so the tray ends the window holding the LATEST state rather than
 * the first one it happened to swallow.
 */
function throttleRunProgress(
  notice: Extract<RunProgressNotice, { verb: 'update' }>,
): Promise<void> {
  const now = Date.now();
  const open = runProgressThrottles.get(notice.identifier);
  const sinceLast = open ? now - open.lastPostedAt : RUN_PROGRESS_THROTTLE_MS;
  if (sinceLast >= RUN_PROGRESS_THROTTLE_MS) {
    clearRunProgressWindow(notice.identifier);
    runProgressThrottles.set(notice.identifier, { lastPostedAt: now });
    return drawRunProgress(notice);
  }
  const throttle: RunProgressThrottle = open ?? { lastPostedAt: now };
  throttle.pending = notice;
  runProgressThrottles.set(notice.identifier, throttle);
  if (!throttle.timer) {
    throttle.timer = setTimeout(() => {
      const held = runProgressThrottles.get(notice.identifier);
      if (!held) return;
      clearRunProgressWindow(notice.identifier);
      runProgressThrottles.set(notice.identifier, { lastPostedAt: Date.now() });
      if (held.pending) void drawRunProgress(held.pending);
    }, RUN_PROGRESS_THROTTLE_MS - sinceLast);
  }
  return Promise.resolve();
}

function clearRunProgressWindow(identifier: string): void {
  const throttle = runProgressThrottles.get(identifier);
  if (throttle?.timer) clearTimeout(throttle.timer);
  runProgressThrottles.delete(identifier);
}

/**
 * Drop every coalescing window this process opened, timers and all.
 *
 * Called when the provider unmounts, so a window left open by the last render
 * before teardown cannot post a held update afterwards for a run nothing is
 * following any more — the same reason `dismissRunProgress` takes its own window
 * with it when a run ends.
 */
export function clearRunProgressThrottles(): void {
  for (const throttle of runProgressThrottles.values()) {
    if (throttle.timer) clearTimeout(throttle.timer);
  }
  runProgressThrottles.clear();
}

/**
 * The same reset, named for the suites that need it: the windows are time-based
 * module state, so a suite that posts the same run in several cases would
 * otherwise inherit the window the case before it left open — the same reason
 * `resetRunActivitiesForTests` exists for the Lock Screen's held map.
 */
export function resetRunProgressThrottleForTests(): void {
  clearRunProgressThrottles();
}

/**
 * Retire one run's progress notice, under the identifier its updates were
 * posted with. Best-effort, like every other dismissal here: what settles a run
 * is the run settling, never the tray.
 *
 * The throttle window for that identifier goes with it, so a run that settles
 * mid-window is not handed one last update for a tray entry that has just been
 * retired.
 */
export async function dismissRunProgress(identifier: string): Promise<void> {
  if (Platform.OS !== 'android') return;
  clearRunProgressWindow(identifier);
  try {
    await Notifications.dismissNotificationAsync(identifier);
  } catch {
    // best-effort: a stale tray entry is cosmetic, never fatal
  }
}

/**
 * Retire the run-progress notices this process did NOT post.
 *
 * Every other retirement path reads `runProgressNoticeIdsRef` in the provider —
 * an in-process set that starts empty, so a notice posted by a process Android
 * then killed (`run-progress:<runId>`, a deterministic identifier) was never
 * retired: the restored row reconciled to complete, `present` refused while the
 * operator was looking at the app, and the tray went on claiming "Run in
 * progress" for a finished run until it was swiped away. This asks the tray
 * itself, so a notice from any process is found.
 *
 * Only run-progress notices are touched, and only ones for runs that are no
 * longer in flight: a live run's notice is the poster's business, and every
 * other notice on the phone is left exactly where it is. Best-effort — a tray
 * that cannot be read is a tray that cannot be swept.
 */
export async function dismissStaleRunProgress(liveRunIds: string[]): Promise<void> {
  if (Platform.OS !== 'android') return;
  const live = new Set(liveRunIds.map((runId) => runProgressNoticeIdentifier(runId)));
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    await Promise.all(
      presented
        // An expo Notification wraps the request (identifier + content) in a
        // `request` field; the sweep reads the identifier from there, the way
        // `dismissGatewayDown` above reads its own.
        .map((notification) => notification.request)
        .filter(
          (request) =>
            request.identifier.startsWith(RUN_PROGRESS_NOTICE_PREFIX) &&
            !live.has(request.identifier),
        )
        .map((request) => Notifications.dismissNotificationAsync(request.identifier)),
    );
  } catch {
    // best-effort: a stale tray entry is cosmetic, never fatal
  }
}
