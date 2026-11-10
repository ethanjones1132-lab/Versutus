/**
 * Today's grouping and filter rules, kept out of the component so they can be
 * exercised without mounting a screen (or its native leaves). Nothing here
 * reads the Gateway; the caller hands over what the feed already proved.
 */

import type { ActivityCoverage, ActivityItem } from '@/lib/gateway/activity-feed';
import type { ActivityRun } from '@/lib/gateway/runs';

export type TodayActivityGroup = { key: string; title: string; items: ActivityItem[] };

type NamedBot = { id: string; displayName: string };

/** Narrow the feed to one backend; `undefined` is the All chip. */
export function filterActivityByBackend(items: ActivityItem[], backendId: string | undefined): ActivityItem[] {
  return backendId ? items.filter((item) => item.backendId === backendId) : items;
}

/**
 * Group by Bot when the Gate proved one, else by backend. A Bot's own group is
 * scoped to its backend, so two hosts that happen to share a Bot id stay two
 * groups. Backends keep the Gate's order, bots keep the roster's order, and
 * rows keep the feed's newest-first order inside a group.
 */
export function groupActivityForToday(
  items: ActivityItem[],
  coverage: ActivityCoverage[],
  bots: NamedBot[],
): TodayActivityGroup[] {
  const botById = new Map(bots.map((bot) => [bot.id, bot]));
  const backendById = new Map(coverage.map((backend) => [backend.id, backend]));
  const groups = new Map<string, TodayActivityGroup>();
  const order: string[] = [];
  for (const item of items) {
    const knownBot = item.botId ? botById.get(item.botId) : undefined;
    const key = knownBot ? `backend:${item.backendId}:bot:${knownBot.id}` : `backend:${item.backendId}`;
    const backendLabel = backendById.get(item.backendId)?.label ?? item.backendId;
    const title = knownBot?.displayName ? `${backendLabel} · ${knownBot.displayName}` : backendLabel;
    const existing = groups.get(key);
    if (existing) existing.items.push(item);
    else {
      groups.set(key, { key, title, items: [item] });
      order.push(key);
    }
  }
  const backendOrder = new Map(coverage.map((backend, index) => [backend.id, index]));
  const botOrder = new Map(bots.map((bot, index) => [bot.id, index]));
  return order.map((key) => groups.get(key)!).sort((a, b) => {
    const aItem = a.items[0];
    const bItem = b.items[0];
    const backendDelta = (backendOrder.get(aItem.backendId) ?? coverage.length) -
      (backendOrder.get(bItem.backendId) ?? coverage.length);
    if (backendDelta) return backendDelta;
    const aBot = aItem.botId && botById.has(aItem.botId) ? botOrder.get(aItem.botId) ?? bots.length : bots.length;
    const bBot = bItem.botId && botById.has(bItem.botId) ? botOrder.get(bItem.botId) ?? bots.length : bots.length;
    return aBot - bBot;
  });
}

/**
 * The app's own runs that are still moving or holding for the operator.
 * ActivityRun uses `running` and `waiting-approval`; anything settled belongs
 * in the day's history instead, and an unknown outcome is not progress.
 */
export function liveRunsForToday(runs: ActivityRun[]): ActivityRun[] {
  return runs.filter((run) => run.status === 'running' || run.status === 'waiting-approval');
}
