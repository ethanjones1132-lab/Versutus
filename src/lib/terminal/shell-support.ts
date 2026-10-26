import type { GatewayCapabilityGroup, GatewayCapabilitySnapshot } from '@/lib/gateway/types';

export type TerminalShellSupport = 'ready' | 'unsupported' | 'unknown';

/**
 * Group statuses that mean "this gateway, as asked, does not offer the
 * terminal group". Everything else that is not `ready` is an absence of
 * evidence rather than evidence of absence: `missing-scope` says the token
 * may not ask, `warming`/`partial` say the probe is unfinished, `unknown`
 * says nobody knows yet.
 */
const CONFIRMED_ABSENT_GROUP_STATUSES: ReadonlySet<GatewayCapabilityGroup['status']> = new Set([
  'unavailable',
  'unsupported',
]);

/**
 * Whether Tools may open an interactive shell, derived from the capability
 * snapshot — the same fact source the dashboard uses. Three states, because
 * two very different reasons can leave the terminal group not-ready:
 *
 * - `ready` — the gateway advertises the terminal group; streaming a shell
 *   will work.
 * - `unsupported` — the snapshot is a completed read (`fresh`/`stale`) and
 *   the completed read found no shell: either the catalog listed no terminal
 *   group at all, or the group it listed is `unavailable`/`unsupported`.
 *   Claiming this before the first capabilities fetch lands would slander
 *   gateways that do offer one.
 * - `unknown` — the gateway is offline, still warming, or only partially
 *   probed; or a present group reported a status that settles nothing
 *   (`missing-scope`, `warming`, `partial`, `unknown`, …). We cannot say
 *   either way yet; the UI must not pretend otherwise.
 */
export function resolveShellSupport(
  snapshot: Pick<GatewayCapabilitySnapshot, 'status' | 'groups'>,
): TerminalShellSupport {
  const group = snapshot.groups.find((item) => item.id === 'terminal');
  // Affirmative evidence stands on any snapshot: the gateway itself says the
  // terminal group is there.
  if (group?.status === 'ready') return 'ready';

  // Only a completed read can say "no". A warming, partial or offline
  // snapshot is still collecting the evidence.
  const completedRead = snapshot.status === 'fresh' || snapshot.status === 'stale';
  if (!completedRead) return 'unknown';

  // Completed read with no terminal group: the catalog enumerated the
  // gateway's families and terminal was not one of them (documented rule).
  if (!group) return 'unsupported';

  // Completed read with a present group: it must actually say the capability
  // is absent. Reporting every other non-ready status as unsupported told
  // operators "No shell on this gateway" when the truth was "we may not ask"
  // or "not confirmed yet" (VS-004 / QUALITY-SCAN-2026-10-11).
  return CONFIRMED_ABSENT_GROUP_STATUSES.has(group.status) ? 'unsupported' : 'unknown';
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
