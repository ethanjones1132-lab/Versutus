import type { GatewayCapabilitySnapshot } from '@/lib/gateway/types';

export type TerminalShellSupport = 'ready' | 'unsupported' | 'unknown';

/**
 * Whether Tools may open an interactive shell, derived from the capability
 * snapshot — the same fact source the dashboard uses. Three states, because
 * two very different reasons can leave the terminal group not-ready:
 *
 * - `ready` — the gateway advertises the terminal group; streaming a shell
 *   will work.
 * - `unsupported` — the snapshot is a completed read (`fresh`/`stale`) and
 *   the gateway still does not advertise a shell. Claiming this before the
 *   first capabilities fetch lands would slander gateways that do offer one.
 * - `unknown` — the gateway is offline, still warming, or only partially
 *   probed. We cannot say either way yet; the UI must not pretend otherwise.
 */
export function resolveShellSupport(
  snapshot: Pick<GatewayCapabilitySnapshot, 'status' | 'groups'>,
): TerminalShellSupport {
  const group = snapshot.groups.find((item) => item.id === 'terminal');
  if (group?.status === 'ready') return 'ready';
  if (snapshot.status === 'fresh' || snapshot.status === 'stale') return 'unsupported';
  return 'unknown';
}

/**
 * Copy for the honest no-shell surface shown when the operator picks Shell on
 * a gateway that cannot stream one. Both flavors point at RPC as the way
 * forward — the difference is only whether "no" is a fact or a not-yet.
 */
export function describeShellUnavailable(
  support: Exclude<TerminalShellSupport, 'ready'>,
  gatewayName: string,
): { title: string; description: string } {
  if (support === 'unsupported') {
    return {
      title: 'No shell on this gateway',
      description: `${gatewayName} does not offer a terminal endpoint. Use Gateway RPC or Agent commands, or open a shell on the gateway host.`,
    };
  }
  return {
    title: 'Shell not confirmed yet',
    description: `Still confirming what ${gatewayName} offers. Gateway RPC and Agent commands work meanwhile.`,
  };
}
