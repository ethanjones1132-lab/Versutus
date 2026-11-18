import { ListRow } from '@/components/ui/ListRow';
import { useTokens } from '@/hooks/use-tokens';
import type { ActivityItem } from '@/lib/gateway/activity-feed';

/** A run state that is still moving, or one that is holding for the operator. */
const ATTENTION_STATES = ['waiting-approval', 'waiting', 'pending', 'required', 'approval'];
const LIVE_STATES = ['active', 'in_progress', 'running'];
const FAILED_STATES = ['failed', 'error', 'cancelled'];

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * The instant the row's time column speaks for. A run that ended is anchored
 * at its finish: a run that began at 23:50 and finished at 00:10 belongs to
 * today's list because it finished today, and it should say 00:10, not the
 * time from yesterday. A run still moving (or with no trustworthy finish)
 * keeps its start. A session keeps its last activity, as it always has.
 */
function anchorFor(item: ActivityItem): Date {
  if (item.kind === 'run' && !LIVE_STATES.includes(item.status.toLowerCase())) {
    const finished = new Date(item.finishedAt ?? '');
    if (Number.isFinite(finished.getTime())) return finished;
  }
  return new Date(item.kind === 'session' ? item.lastActiveAt ?? item.startedAt : item.startedAt);
}

/** The row's own local day, named only when it is not the device's today. */
function localDay(date: Date): string {
  try {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
  } catch {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
}

function isToday(date: Date, now = new Date()): boolean {
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
}

/**
 * `14:27` for a row from today, `Nov 13, 14:27` for one whose anchor is from
 * another day. The list is labelled "since midnight", but a read carried past
 * midnight (or a run with an untrustworthy finish) can hold a row whose own
 * day is not today; that row must carry its date rather than borrow today's.
 */
function timeLabel(anchor: Date): string | undefined {
  if (!Number.isFinite(anchor.getTime())) return undefined;
  const time = `${pad(anchor.getHours())}:${pad(anchor.getMinutes())}`;
  return isToday(anchor) ? time : `${localDay(anchor)}, ${time}`;
}

/** The exact owner a tapped row proved, so the tap cannot open another's thread. */
export type ActivitySessionTarget = {
  sessionId: string;
  backendId: string;
  botId?: string;
};

/**
 * One line of today's history. The subtitle carries only the metrics the Gate
 * actually reported: an unknown count is absent, never 0.
 *
 * A run row is not pressable yet. The feed id is the Gate's composite
 * `<backend>:run:<id>`, which the app's Runs screen does not address, and the
 * archived environment run is not the same kind of run Runs lists. A tap that
 * opened the wrong thing would be worse than no tap.
 */
export function ActivityRow({
  item,
  onOpenSession,
}: {
  item: ActivityItem;
  onOpenRun?: (runId: string) => void;
  onOpenSession?: (target: ActivitySessionTarget) => void;
}) {
  const tokens = useTokens();
  const time = timeLabel(anchorFor(item));
  const metadata = [
    typeof item.metrics.turns === 'number' ? `${item.metrics.turns} turns` : undefined,
    typeof item.metrics.tools === 'number' ? `${item.metrics.tools} tools` : undefined,
    time,
    typeof item.metrics.costUsd === 'number' ? `$${item.metrics.costUsd.toFixed(2)}` : undefined,
  ].filter((part): part is string => part !== undefined).join(' · ');
  const status = item.status.toLowerCase();
  const statusColor = LIVE_STATES.includes(status)
    ? tokens.accent
    : ATTENTION_STATES.includes(status)
      ? tokens.statusConnecting
      : FAILED_STATES.includes(status)
        ? tokens.statusDisconnected
        : tokens.statusConnected;
  const sessionId = item.sessionId;
  const onPress = item.kind === 'session' && sessionId && onOpenSession
    ? () => onOpenSession({
        sessionId,
        backendId: item.backendId,
        ...(item.botId ? { botId: item.botId } : {}),
      })
    : undefined;

  return (
    <ListRow
      title={item.title}
      subtitle={metadata || undefined}
      statusColor={statusColor}
      onPress={onPress}
    />
  );
}
