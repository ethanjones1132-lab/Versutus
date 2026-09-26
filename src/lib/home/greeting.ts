import type { ConnectionStatus } from '@/lib/gateway/types';

/**
 * The roster's serif greeting, by the operator's local hour. Past ten it
 * stops pretending it is still evening.
 */
export function greetingFor(date: Date): string {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  if (hour >= 17 && hour < 22) return 'Good evening';
  return 'Working late';
}

/**
 * The one quiet line under the greeting: which Gate this is and whether the
 * team behind it can take work. Plain words — never a protocol state name.
 */
export function gateLineFor(input: {
  gatewayName: string;
  status: ConnectionStatus;
  /** Bots that can route right now. */
  readyBots: number;
  /** Every Bot the roster knows, routable or not. */
  totalBots: number;
}): string {
  const { gatewayName, status, readyBots, totalBots } = input;
  if (status === 'connecting' || status === 'reconnecting') return `Reaching ${gatewayName}…`;
  if (status === 'pairing') return `${gatewayName} is waiting for this phone to be approved`;
  if (status !== 'connected') return `${gatewayName} is offline — messages will wait`;
  if (totalBots === 0) return `${gatewayName} is connected`;
  if (readyBots === totalBots) {
    return totalBots === 1 ? `${gatewayName} · your Bot is ready` : `${gatewayName} · all ${totalBots} Bots ready`;
  }
  return `${gatewayName} · ${readyBots} of ${totalBots} Bots ready`;
}
