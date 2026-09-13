// ─── The Android widget's payload ─────────────────────────────────
// The iOS widget draws `glanceableWidgetLines(snapshot)` inside expo-widgets'
// SwiftUI runtime. Android has no such runtime in this SDK, so its native
// Glance card is handed the same lines as data. The stamp is the one line not
// pre-rendered: the card formats it at draw time from `writtenAt`, so "Today"
// never goes stale on a home screen overnight.

import type { VersutusWidgetPayload } from '../../../modules/versutus-widget/src/VersutusWidget.types';
import type { GlanceableSnapshot } from '@/lib/widget/snapshot';
import { glanceableWidgetLines } from '@/lib/widget/widget-target';

export function androidWidgetPayload(snapshot: GlanceableSnapshot): VersutusWidgetPayload {
  const lines = glanceableWidgetLines(snapshot);
  return {
    v: 1,
    status: lines.status,
    connected: snapshot.status === 'connected',
    work: lines.work,
    ...(lines.result ? { result: lines.result } : {}),
    approvalsPending: Math.max(0, Math.trunc(snapshot.approvalsPending)),
    writtenAt: snapshot.writtenAt,
  };
}
