// ─── Fleet constellation: the provider projection ─────────────────────────
// D2's screen is a read-only lens over state the app already holds. This is
// the one place that state is folded into the pure model's input, so the
// screen never re-derives the graph and the fold itself is unit-testable.
//
// No protocol lives here: the reachability sample is the probe wave's already
// stamped `checkedAt`, the roster is the existing `listBots` read, and a
// pending run approval is attributed to the Bot its run row names — an orphan
// approval stays unattributed rather than guessing a Bot.

import type { ConstellationInput } from '@/lib/fleet/constellation-model';

export type FleetProjectionGateway = { id: string; name?: string };
export type FleetProjectionReachability = { state?: string; checkedAt?: number };
export type FleetProjectionRun = { id: string; botId?: string; status: string };
export type FleetProjectionBot = { id: string; displayName?: string };

export type FleetConstellationArgs = {
  gateways?: FleetProjectionGateway[];
  connectedGatewayId?: string | null;
  reachability?: Record<string, FleetProjectionReachability | undefined>;
  roster?: FleetProjectionBot[];
  activityRuns?: FleetProjectionRun[];
  pendingRunApproval?: { runId: string } | null;
};

export function fleetConstellationInput(args: FleetConstellationArgs): ConstellationInput {
  const profiles = (args.gateways ?? []).map((gateway) => {
    const name = gateway.name?.trim();
    return name ? { id: gateway.id, name } : { id: gateway.id };
  });

  const reachability: Record<string, { lastProbeAt: number }> = {};
  for (const [gatewayId, sample] of Object.entries(args.reachability ?? {})) {
    const checkedAt = sample?.checkedAt;
    if (typeof checkedAt === 'number' && Number.isFinite(checkedAt)) {
      reachability[gatewayId] = { lastProbeAt: checkedAt };
    }
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
  const input: ConstellationInput = {
    profiles,
    reachability,
    roster: args.roster ?? [],
    activityRuns,
    pendingApprovals,
  };
  if (connectedGatewayId) input.connectedGatewayId = connectedGatewayId;
  return input;
}

function attributionForRun(
  runId: string,
  runs: { id: string; botId?: string }[],
): { botId?: string } {
  const run = runs.find((candidate) => candidate.id === runId);
  return run?.botId ? { botId: run.botId } : {};
}
