// ─── The widget's push-carried snapshot ───────────────────────────
// A data-only push (the Gate's M3 companion message) can update the widget
// while the app is closed. Android delivers only data-only messages to a
// headless background task (expo-notifications v57), and Doze may delay them —
// which is fine: the card always stamps the data it is showing.
//
// The message is a WORK LINE, not a snapshot: `setPayload` replaces the single
// stored payload outright, and a key the companion omits parses as EMPTY, not
// unchanged, so forwarding it verbatim wipes the roster, the run rows and the
// pinned Bot's name off the card until the app next opens. So it is merged onto
// the payload the app last wrote (`WIDGET_LAST_PAYLOAD_KEY`), which the app's
// own write records for exactly this purpose.
//
// Two things the Gate cannot know are decided here, because this task runs in
// the app's own JS runtime and can read both:
// - PRIVACY. "Hide result text on the widget" is a device preference the Gate
//   never receives; the companion decides redaction from an unrelated tray
//   setting. The switch is read here, so a rich push cannot put the text back.
// - CONNECTION. The Gate has no reading of this phone's link, so a companion
//   makes no connection claim at all. Only a recent app write can speak for it.

import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { loadWidgetResultHidden } from '@/lib/settings/widget-privacy';
import {
  androidWidgetPayloadIsDrawable,
  androidWidgetStatusWord,
} from '@/lib/widget/android-widget-payload';
import {
  loadAndroidWidgetModule,
  readLastWidgetPayload,
  saveLastWidgetPayload,
  type AndroidWidgetModule,
} from '@/lib/widget/widget-device';
import { WIDGET_WRITE_FLOOR_MS } from '@/lib/widget/widget-write-gate';
import type { VersutusWidgetPayload } from '../../../modules/versutus-widget/src/VersutusWidget.types';

/** The task name the Gate's companion message is delivered under. */
export const WIDGET_PUSH_TASK = 'versutus-widget-push';

/** The v2 widget payload in a notification's data, or null when it carries none. */
export function widgetPayloadFromData(data: unknown): string | null {
  const widget = widgetPushPayload(data);
  return widget ? JSON.stringify(widget) : null;
}

function widgetPushPayload(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const widget = (data as Record<string, unknown>).widget;
  if (!widget || typeof widget !== 'object' || Array.isArray(widget)) return null;
  return widget as Record<string, unknown>;
}

/** The app's own word for a link it cannot vouch for — not invented here. */
const DISCONNECTED_WORD = androidWidgetStatusWord('disconnected');

/** A stored payload from another build, read back defensively. */
function lastWidgetPayloadFrom(json: string | null): VersutusWidgetPayload | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as VersutusWidgetPayload;
  } catch {
    return null;
  }
}

function pushedText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function pushedCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function pushedStamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Fold a companion message onto the payload the app last wrote.
 *
 * Kept: the run rows, the Bot rows, the configuration Roster and the routine
 * tallies — all of it the app's own fold and none of it the Gate can see.
 * Replaced: the work line, the approval count and the stamp the message carries.
 * The result is the message's alone, and only while the device has not asked for
 * it to stay off the card.
 *
 * `connected` is never taken from the message. The previous answer is kept only
 * while it is still true of this phone — a write younger than the gate's own
 * floor — and otherwise the card is told the app cannot vouch for the link,
 * which is the one thing it must never overclaim.
 */
export function mergeWidgetPushPayload(
  pushed: unknown,
  last: VersutusWidgetPayload | null,
  hidden: boolean,
  now: number,
): VersutusWidgetPayload | null {
  const claim = widgetPushPayload({ widget: pushed });
  if (!claim) return null;

  const work = pushedText(claim.work) ?? last?.work;
  const approvalsPending = pushedCount(claim.approvalsPending) ?? last?.approvalsPending ?? 0;
  const writtenAt = pushedStamp(claim.writtenAt) ?? last?.writtenAt ?? 0;
  const result = pushedText(claim.result);
  const redact = hidden || last?.redact === true;
  // How long this phone's last app write still speaks for it.
  const fresh = last !== null && now - last.writtenAt < WIDGET_WRITE_FLOOR_MS;

  const payload: VersutusWidgetPayload = {
    // Version 3 whatever the companion said: this payload carries the Roster and
    // the tallies, which only v3 reads.
    v: 3,
    status: fresh && last ? last.status : DISCONNECTED_WORD,
    connected: fresh && last?.connected === true,
    work: work ?? '',
    ...(!redact && result ? { result } : {}),
    ...(!redact && last?.runs ? { runs: last.runs } : {}),
    ...(!redact && last?.bots ? { bots: last.bots } : {}),
    ...(!redact && last?.configBots ? { configBots: last.configBots } : {}),
    // Counts are not names, so they survive redaction exactly as the app's own
    // payload writes them.
    ...(last?.routinesFailing !== undefined ? { routinesFailing: last.routinesFailing } : {}),
    ...(last?.routinesLate !== undefined ? { routinesLate: last.routinesLate } : {}),
    ...(redact ? { redact: true } : {}),
    approvalsPending,
    writtenAt,
  };

  // A payload the card would refuse must never replace the last good one it is
  // still honestly stamping, so the merge answers null rather than writing.
  return androidWidgetPayloadIsDrawable(payload) ? payload : null;
}

/** Hand a push message's widget payload to the Glance module; true when one was written. */
export async function handleWidgetPush(
  data: unknown,
  load: () => Promise<AndroidWidgetModule | null> = loadAndroidWidgetModule,
): Promise<boolean> {
  const pushed = widgetPushPayload(data);
  if (!pushed) return false;
  try {
    const module = await load();
    if (!module) return false;
    const [hidden, lastJson] = await Promise.all([loadWidgetResultHidden(), readLastWidgetPayload()]);
    const merged = mergeWidgetPushPayload(pushed, lastWidgetPayloadFrom(lastJson), hidden, Date.now());
    if (!merged) return false;
    const json = JSON.stringify(merged);
    if ((await module.setPayload(json)) !== true) return false;
    // Only what the card actually took becomes the next merge's base.
    await saveLastWidgetPayload(json);
    return true;
  } catch {
    // The card keeps the snapshot it already holds; the task stays registered.
    return false;
  }
}

TaskManager.defineTask(WIDGET_PUSH_TASK, async ({ data }) => {
  await handleWidgetPush(data);
});

/** Ask Android to run the task for data-only pushes. */
export async function registerWidgetPushTask(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.registerTaskAsync(WIDGET_PUSH_TASK);
}
