// ─── Fleet constellation: the provider projection ─────────────────────────
// D2's screen is a read-only lens over state the app already holds. This is
// the one place that state is folded into the pure model's input, so the
// screen never re-derives the graph and the fold itself is unit-testable.
//
// No protocol lives here: the reachability sample is the probe wave's already
// stamped `checkedAt`, the roster is the existing `listBots` read, and a
// pending run approval is attributed to the Bot its run row names — an orphan
// approval stays unattributed rather than guessing a Bot.

import type { ConstellationInput, FleetReachability } from '@/lib/fleet/constellation-model';
import type { FleetRosterReadStatus } from '@/lib/fleet/roster-read';
import type { FleetRoutineReadStatus } from '@/lib/fleet/routine-read';
import type { GatewayCapabilitySnapshot } from '@/lib/gateway/types';

export type FleetProjectionGateway = { id: string; name?: string };
export type FleetProjectionReachability = {
  state?: string;
  checkedAt?: number;
  latencyMs?: number;
  error?: string;
};
export type FleetProjectionRun = { id: string; botId?: string; status: string };
export type FleetProjectionBot = { id: string; displayName?: string };

export type FleetConstellationArgs = {
  gateways?: FleetProjectionGateway[];
  connectedGatewayId?: string | null;
  capabilitySnapshot?: GatewayCapabilitySnapshot;
  reachability?: Record<string, FleetProjectionReachability | undefined>;
  roster?: FleetProjectionBot[];
  rosterReadStatus?: FleetRosterReadStatus;
  cronJobs?: unknown[];
  routineReadStatus?: FleetRoutineReadStatus;
  activityRuns?: FleetProjectionRun[];
  pendingRunApproval?: { runId: string } | null;
};

export function fleetConstellationInput(args: FleetConstellationArgs): ConstellationInput {
  const profiles = (args.gateways ?? []).map((gateway) => {
    const name = gateway.name?.trim();
    return name ? { id: gateway.id, name } : { id: gateway.id };
  });

  const reachability: FleetReachability = {};
  for (const [gatewayId, sample] of Object.entries(args.reachability ?? {})) {
    // A cached connected sample is not proof of a connection now; only
    // connectedGatewayId can make a gateway live.
    const state = sample?.state;
    const verdict: NonNullable<FleetReachability[string]> = {
      state: state === 'reachable' || state === 'unreachable' || state === 'checking'
        ? state : 'unknown',
    };
    const checkedAt = sample?.checkedAt;
    if (typeof checkedAt === 'number' && Number.isFinite(checkedAt)) {
      verdict.lastProbeAt = checkedAt;
    }
    if (state === 'reachable') verdict.latencyMs = sample?.latencyMs;
    if (state === 'unreachable') verdict.error = sample?.error;
    reachability[gatewayId] = verdict;
  }

  const activityRuns = (args.activityRuns ?? []).map((run) => {
    const botId = run.botId?.trim();
    return botId ? { id: run.id, botId, status: run.status } : { id: run.id, status: run.status };
  });

  const pendingRunId = args.pendingRunApproval?.runId;
  const pendingApprovals = pendingRunId
    ? [attributionForRun(pendingRunId, activityRuns)]
    : [];

  const connectedGatewayId = args.connectedGatewayId ?? undefined;
  // The routine read rides along as the model's own shape — no re-parse
  // here, no loss: the fold into arcs is the model's, so the projection and
  // the Activity surface consume the same rows the same way.
  const input: ConstellationInput = {
    profiles,
    reachability,
    roster: args.roster ?? [],
    rosterReadStatus: args.rosterReadStatus,
    activityRuns,
    pendingApprovals,
    cronJobs: args.cronJobs ?? [],
    routineReadStatus: args.routineReadStatus,
  };
  if (connectedGatewayId) {
    input.connectedGatewayId = connectedGatewayId;
    input.capabilitySnapshot = args.capabilitySnapshot;
  }
  return input;
}

function attributionForRun(
  runId: string,
  runs: { id: string; botId?: string }[],
): { botId?: string } {
  const run = runs.find((candidate) => candidate.id === runId);
  return run?.botId ? { botId: run.botId } : {};
}
