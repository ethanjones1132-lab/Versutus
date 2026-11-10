import { ListRow } from '@/components/ui/ListRow';
import { useTokens } from '@/hooks/use-tokens';
import type { ActivityItem } from '@/lib/gateway/activity-feed';

/** A run state that is still moving, or one that is holding for the operator. */
const ATTENTION_STATES = ['waiting-approval', 'waiting', 'pending', 'required', 'approval'];
const LIVE_STATES = ['active', 'in_progress', 'running'];
const FAILED_STATES = ['failed', 'error', 'cancelled'];

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
  const date = new Date(item.startedAt);
  const time = Number.isFinite(date.getTime())
    ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    : undefined;
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
