// ─── The Android widget's payload ─────────────────────────────────
// The iOS widget draws `glanceableWidgetLines(snapshot)` inside expo-widgets'
// SwiftUI runtime. Android has no such runtime in this SDK, so its native
// Glance card is handed the same lines as data. The stamp is the one line not
// pre-rendered: the card formats it at draw time from `writtenAt`, so "Today"
// never goes stale on a home screen overnight.

import type { ConnectionStatus } from '@/lib/gateway/types';
import type { VersutusWidgetPayload } from '../../../modules/versutus-widget/src/VersutusWidget.types';
import type { GlanceableSnapshot } from '@/lib/widget/snapshot';
import { glanceableWidgetLines } from '@/lib/widget/widget-target';

export function androidWidgetPayload(snapshot: GlanceableSnapshot): VersutusWidgetPayload {
  const lines = glanceableWidgetLines(snapshot);
  const runs = (snapshot.runs ?? []).slice(0, 3);
  const bots = (snapshot.bots ?? []).slice(0, 3);
  const redact = snapshot.redact === true;
  return {
    v: 3,
    status: lines.status,
    connected: snapshot.status === 'connected',
    work: lines.work,
    ...(!redact && lines.result ? { result: lines.result } : {}),
    ...(!redact && runs.length > 0 ? { runs } : {}),
    ...(!redact && bots.length > 0 ? { bots } : {}),
    ...(!redact && snapshot.configBots !== undefined ? { configBots: snapshot.configBots } : {}),
    ...(snapshot.routineAlerts && (snapshot.routineAlerts.failing > 0 || snapshot.routineAlerts.late > 0)
      ? {
          routinesFailing: Math.max(0, Math.trunc(snapshot.routineAlerts.failing)),
          routinesLate: Math.max(0, Math.trunc(snapshot.routineAlerts.late)),
        }
      : {}),
    ...(redact ? { redact: true } : {}),
    approvalsPending: Math.max(0, Math.trunc(snapshot.approvalsPending)),
    writtenAt: snapshot.writtenAt,
  };
}

/**
 * The status word the card draws for a connection status, read from the fold the
 * app's own writes go through rather than re-worded, so the two cannot drift.
 */
export function androidWidgetStatusWord(status: ConnectionStatus): string {
  return glanceableWidgetLines({ status, runsInFlight: 0, approvalsPending: 0, writtenAt: 0 }).status;
}

/**
 * Whether the native card could draw this payload at all: the same refusals
 * `WidgetPayload.parse` makes before it stores anything, so a payload that would
 * be refused never replaces the last good one the card is still honestly
 * stamping. Kept here so the payload shape has one owner.
 */
export function androidWidgetPayloadIsDrawable(payload: VersutusWidgetPayload): boolean {
  return (
    (payload.v === 1 || payload.v === 2 || payload.v === 3) &&
    typeof payload.status === 'string' && payload.status.trim() !== '' &&
    typeof payload.work === 'string' && payload.work.trim() !== '' &&
    typeof payload.connected === 'boolean' &&
    Number.isFinite(payload.approvalsPending) && payload.approvalsPending >= 0 &&
    Number.isFinite(payload.writtenAt) && payload.writtenAt > 0
  );
}
