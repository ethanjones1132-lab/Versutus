/**
 * Today's grouping and filter rules, kept out of the component so they can be
 * exercised without mounting a screen (or its native leaves). Nothing here
 * reads the Gateway; the caller hands over what the feed already proved.
 */

import type { ActivityCoverage, ActivityItem } from '@/lib/gateway/activity-feed';
import type { ActivityRun } from '@/lib/gateway/runs';
import { runIsInFlight } from '@/lib/activity/run-partition';

export type TodayActivityGroup = { key: string; title: string; items: ActivityItem[] };

type NamedBot = { id: string; displayName: string };

/** Local day boundary and the device's short timezone label, from the read's since instant. */
export function sinceMidnightAnchor(since: string, locale?: string): string {
  const date = new Date(since);
  if (!Number.isFinite(date.getTime())) return 'Since midnight · local date · local time';
  let localDate = 'local date';
  let zone = 'local time';
  try {
    localDate = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date);
  } catch {
    // The read boundary is still known even if this device has no formatter.
  }
  try {
    const zonePart = new Intl.DateTimeFormat(locale, { timeZoneName: 'short' })
      .formatToParts(date)
      .find((part) => part.type === 'timeZoneName')?.value;
    zone = zonePart || new Intl.DateTimeFormat().resolvedOptions().timeZone || zone;
  } catch {
    // Keep the neutral local-time label on runtimes without timezone formatting.
  }
  return `Since midnight · ${localDate} · ${zone}`;
}

/** Narrow the feed to one backend; `undefined` is the All chip. */
export function filterActivityByBackend(items: ActivityItem[], backendId: string | undefined): ActivityItem[] {
  return backendId ? items.filter((item) => item.backendId === backendId) : items;
}

/**
 * Group by Bot when the Gate proved one, else by backend. Bots keep the
 * roster's order ahead of backend-only groups, which keep the Gate's order.
 * Rows keep the feed's newest-first order inside a group.
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
    const key = knownBot ? `bot:${knownBot.id}` : `backend:${item.backendId}`;
    const backendLabel = backendById.get(item.backendId)?.label ?? item.backendId;
    const title = knownBot?.displayName ? `Bot ${knownBot.displayName}` : backendLabel;
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
    const aBot = aItem.botId && botById.has(aItem.botId) ? botOrder.get(aItem.botId) ?? bots.length : undefined;
    const bBot = bItem.botId && botById.has(bItem.botId) ? botOrder.get(bItem.botId) ?? bots.length : undefined;
    if (aBot !== undefined || bBot !== undefined) {
      if (aBot === undefined) return 1;
      if (bBot === undefined) return -1;
      return aBot - bBot;
    }
    return (backendOrder.get(aItem.backendId) ?? coverage.length) -
      (backendOrder.get(bItem.backendId) ?? coverage.length);
  });
}

/**
 * The app's own runs that are still moving or holding for the operator.
 * `runIsInFlight` is the one verdict the glance, the drawer, Home and the
 * widget share, so a row restored from disk whose fate this device never
 * learned stays here — the gateway may still be executing it — until a settle
 * re-poll gives it a real end. Anything settled belongs in the day's history.
 */
export function liveRunsForToday(runs: ActivityRun[]): ActivityRun[] {
  return runs.filter(runIsInFlight);
}
