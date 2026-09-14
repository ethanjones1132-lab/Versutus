// ─── Which widget edges are connection edges ───────────────────────────────
// The provider's write effect (gateway-provider.tsx, item 4c's write point)
// fires on every change to the facts the snapshot folds — but only the status
// flips are connection edges the app already knows about. A flip whose next
// snapshot write already repaints the widget's content is the edge that should
// also re-arm the widget's own cadence on Android
// (`Widget.reload()`, expo-widgets/build/Widgets.js:12-16 →
// `ACTION_APPWIDGET_UPDATE` on the plugin's provider), because without it a
// connect that landed while the process was backgrounded leaves the widget's
// default cadence un-scheduled until its next alarm.
//
// Pure and imported by nothing but the provider and its test, so the table
// stays a decision, not a side effect. The status vocabulary is the
// connection status one (CONTEXT.md): disconnected, connecting, reconnecting,
// connected, pairing.

import type { ConnectionStatus } from '@/lib/gateway/types';

/**
 * Why the widget should be asked to move: `'snapshot'` when the edge is a
 * connection status flip — the snapshot write that already rides the same
 * effect repaints the content, and the reload re-arms the cadence — and
 * `'none'` for every other reason, including the effect's very first run,
 * where there is no previous status to flip from.
 */
export type WidgetReloadReason = 'snapshot' | 'none';

export function widgetReloadReason(
  status: ConnectionStatus,
  prevStatus: ConnectionStatus | null,
): WidgetReloadReason {
  if (prevStatus === null || prevStatus === status) return 'none';
  return 'snapshot';
}
