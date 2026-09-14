// ─── D2 fleet constellation: the pure model ───────────────────────
// The Skia map needs a positioned node/edge graph before any renderer runs
// (FUTURE-ITEMS.md §D2 Build 2). This module is that fold: it takes what the
// surfaces already hold — the saved gateway roster, the probe wave's own
// reachability records, and the provider's connection facts — and answers
// where every gateway node sits and which of the map's TWO truth classes it
// belongs to. Pure: it fetches nothing, stores nothing, and draws nothing.
// The renderer draws only what this fold emits.
//
// The honesty rules this fold enforces, quoted from the spec's own shaping:
// - `live` is ONE thing: the connected gateway. Id must match AND the
//   provider's status must be `connected` — a probe that answered
//   `reachable` is a health sample, never a connection, and a mid-handshake
//   name (`connecting`, `pairing`, `reconnecting`) is not a live gateway yet.
// - Everything else is `saved`. A saved node carries the reachability record
//   it was handed — the wave's own state and `checkedAt` stamp — so the
//   surface can dim it and date it "last seen …" without the model ever
//   dating it from a clock of its own.
// - A saved gateway with no record yet is not labeled at all rather than
//   guessed "unreachable": answering nothing is the honest unknown.

import type { PublicBot } from '@/lib/gateway/bots';
import type { CronHealth, CronJob } from '@/lib/gateway/cron';
import type { GatewayReachability } from '@/lib/gateway/dashboard';
import type { ActivityRun } from '@/lib/gateway/runs';
import type { ConnectionStatus, GatewayProfile } from '@/lib/gateway/types';
import { describeCronHealth } from '@/lib/gateway/cron';
import { parseRoutineName } from '@/lib/gateway/routines';

/** A botId only the scorecard's own rule promotes to a name — never a guess. */
function attributedBotId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The run statuses that are still happening — the ones a live map may pulse.
 * A settled run (complete, failed, cancelled, unresolved) is history the
 * Activity tab owns, not a pulse: fate stays `scorecardFate`'s own vocabulary.
 */
const LIVE_RUN_STATUSES: readonly ActivityRun['status'][] = ['running', 'waiting-approval'];

/**
 * How far the outer ring sits from the canvas centre, as a share of the
 * smaller side. A number, not a rule: the renderer's only geometry it must
 * not re-derive, because the ring is what makes N gateways readable as one
 * fleet.
 */
export const CONSTELLATION_RING_RADIUS = 0.72;

/** The two truth classes the constellation renders, visually distinct. */
export type ConstellationTruth = 'live' | 'saved';

/**
 * Which class one gateway node belongs to. The spec's own constraint
 * (FUTURE-ITEMS.md §D2): the connected gateway is live; saved-but-not-
 * connected gateways are dimmed and dated, never green.
 */
export function constellationNodeClass({
  gatewayId,
  activeGatewayId,
  status,
}: {
  gatewayId: string;
  activeGatewayId: string | null;
  status: ConnectionStatus;
}): ConstellationTruth {
  return status === 'connected' && activeGatewayId === gatewayId ? 'live' : 'saved';
}

/** One positioned gateway node on the ring. */
export type ConstellationGatewayNode = {
  gatewayId: string;
  gatewayName: string;
  truth: ConstellationTruth;
  /** Position, in shares of the canvas (multiply by width/height to draw). */
  x: number;
  y: number;
  /**
   * The probe wave's own record for this gateway, handed through un-reworded —
   * absent when no wave has reached it, so the surface says nothing rather
   * than inventing a "last seen" it cannot back.
   */
  reachability?: GatewayReachability;
  /**
   * Live runs this gateway owns — the connected gateway only, counting the
   * runs it attributes to no Bot (they were started in configurable chat or
   * persisted before attribution existed). Absent when nothing is live.
   */
  activityRuns?: number;
  /**
   * The provider's own pending approval, handed through un-reworded. It hangs
   * on the connected gateway — the connection the run is waiting on — never
   * on a Bot, and never on a saved node. Absent when nobody is waiting.
   */
  pendingApproval?: { runId: string; prompt: string };
};

/** The ring the gateway nodes sit on, in the same shares the nodes use. */
export type ConstellationRing = { cx: number; cy: number; radius: number };

/** One Bot node clustered beneath its gateway. */
export type ConstellationBotNode = {
  botId: string;
  botName: string;
  /** The gateway this Bot hangs beneath — always the live one; see the fold. */
  gatewayId: string;
  /** Handed through from the roster; `false` is still drawn, but flagged. */
  routable: boolean;
  /**
   * Live runs attributed to this Bot (status `running` or `waiting-approval`
   * — a settled run pulses nothing). Absent when the Bot is quiet.
   */
  activityRuns?: number;
  /**
   * Runs of this Bot's that sit `waiting-approval` — the pulse's alarm, the
   * renderer's cue to draw the waiting Bot distinctly.
   */
  awaitingApproval?: number;
  /** Position, in the same shares the gateway nodes use. */
  x: number;
  y: number;
};

/** One gateway→Bot edge; the renderer draws only what the model emits. */
export type ConstellationEdge =
  | { kind: 'gateway-bot'; gatewayId: string; botId: string };

/**
 * One routine arc: a cron job folded onto the graph, gateway→Bot. The Bot
 * attribution is `parseRoutineName`'s own read and the verdict is
 * `describeCronHealth`'s own answer, both un-reworded — the same fold
 * `scorecardRoutineHealth` runs. A job whose name carries no Bot emits an
 * arc attributed to nobody rather than guessed into a Bot's.
 */
export type ConstellationRoutineArc = {
  kind: 'routine';
  gatewayId: string;
  botId?: string;
  verdict: CronHealth;
};

/** The whole model one fold emits; the Skia layer draws only this. */
export type ConstellationModel = {
  gateways: ConstellationGatewayNode[];
  /** Bot nodes, clustered beneath the live gateway only. */
  bots: ConstellationBotNode[];
  edges: ConstellationEdge[];
  /** Routine arcs — one per cron job handed in, gateway→its attributed Bot. */
  routines: ConstellationRoutineArc[];
  ring: ConstellationRing;
};

/**
 * How far beneath a gateway node its Bot cluster sits, and across how wide an
 * arc it spreads, both as shares of the canvas so the renderer scales nothing
 * of its own.
 */
const CLUSTER_DROP = 0.08;
const CLUSTER_SPREAD = 0.3;

/**
 * Fold the fleet onto the ring. Positioning is deterministic per input:
 * roster order fixes the angles (the roster's own order, the one Home and
 * settings already show), so N gateways fold to N distinct ring seats and
 * the same roster always folds to the same map.
 */
export function foldConstellation({
  profiles,
  reachability,
  activeGatewayId,
  status,
  roster = [],
  activityRuns = [],
  pendingApproval,
  cronJobs = [],
  width,
  height,
}: {
  profiles: GatewayProfile[];
  reachability: Record<string, GatewayReachability>;
  activeGatewayId: string | null;
  status: ConnectionStatus;
  /**
   * The connected gateway's own roster, obtained through the provider's
   * `listBots` — handed in, never fetched here. Only the live gateway's Bots
   * are projected: a saved gateway's roster is unknown to this client and is
   * never cached-and-guessed onto its node.
   */
  roster?: PublicBot[];
  /**
   * The provider's own `activityRuns` — handed in, never fetched here. Only
   * the still-happening statuses pulse; a settled run is the Activity tab's
   * history and stays `scorecardFate`'s own vocabulary.
   */
  activityRuns?: ActivityRun[];
  /**
   * The provider's own `pendingRunApproval`, handed through un-reworded and
   * only onto the connected gateway's node.
   */
  pendingApproval?: { runId: string; prompt: string } | null;
  /**
   * The cron list read (`cron.list` from the provider), handed in — one arc
   * per job, attributed by `parseRoutineName` and verdicted by
   * `describeCronHealth`, the exact fold `scorecardRoutineHealth` runs.
   */
  cronJobs?: CronJob[];
  width: number;
  height: number;
  now: number;
}): ConstellationModel {
  const cx = width / 2;
  const cy = height / 2;
  // A canvas that cannot be drawn (zero, negative, not finite) answers a
  // zero-radius ring and no nodes rather than a scatter off-canvas.
  const drawable =
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0;
  const radius = drawable ? (CONSTELLATION_RING_RADIUS * Math.min(width, height)) / 2 : 0;
  const ring: ConstellationRing = { cx, cy, radius };

  const empty: ConstellationModel = { gateways: [], bots: [], edges: [], routines: [], ring };

  if (!drawable || profiles.length === 0) {
    return empty;
  }

  const gateways = profiles.map((profile, index) => ({
    gatewayId: profile.id,
    gatewayName: profile.name,
    truth: constellationNodeClass({ gatewayId: profile.id, activeGatewayId, status }),
    // Start from the ring's 12 o'clock and walk clockwise; the seat count is
    // the roster's own count, so no seat is ever shared.
    x: (cx + radius * Math.sin((2 * Math.PI * index) / profiles.length)) / width,
    y: (cy - radius * Math.cos((2 * Math.PI * index) / profiles.length)) / height,
    reachability: reachability[profile.id],
  })) as (ConstellationGatewayNode & { activityRuns?: number; pendingApproval?: { runId: string; prompt: string } })[];

  // Bots cluster beneath the live gateway ONLY — the one gateway whose roster
  // this client actually holds (`roster` is that gateway's own `listBots`
  // answer, handed in). A saved gateway's rosters are unknown, so a saved node
  // gains no Bots rather than cached-and-guessed ones; with no live gateway
  // there is nowhere to hang the cluster and it is not drawn.
  const live = gateways.find((node) => node.truth === 'live');

  // Run pulses. A run whose status is still happening pulses the Bot its
  // `botId` names (the roster covers that); an unattributed run is never
  // guessed into a Bot — it pulses the gateway node, the same rule
  // `buildScorecards` applies through `scorecardBotId`. A settled run pulses
  // nothing, and a saved gateway is nobody's run target.
  const liveRunCounts = new Map<string, number>();
  const approvalCounts = new Map<string, number>();
  let liveGatewayRuns = 0;
  for (const run of activityRuns) {
    if (!LIVE_RUN_STATUSES.includes(run.status)) continue;
    const botId = attributedBotId(run.botId);
    if (botId) {
      liveRunCounts.set(botId, (liveRunCounts.get(botId) ?? 0) + 1);
      if (run.status === 'waiting-approval') {
        approvalCounts.set(botId, (approvalCounts.get(botId) ?? 0) + 1);
      }
    } else if (live) {
      liveGatewayRuns += 1;
    }
  }
  if (live && liveGatewayRuns > 0) {
    live.activityRuns = liveGatewayRuns;
  }
  if (live && pendingApproval) {
    live.pendingApproval = pendingApproval;
  }

  if (!live) {
    return { gateways, bots: [], edges: [], routines: [], ring };
  }
  const bots: ConstellationBotNode[] = roster.map((bot, index) => ({
    botId: bot.id,
    botName: bot.displayName,
    gatewayId: live.gatewayId,
    routable: bot.routable,
    // The pulse carries onto the node only when the Bot actually has live
    // runs — a quiet Bot stays absent-valued so the surface draws nothing.
    ...(liveRunCounts.has(bot.id)
      ? { activityRuns: liveRunCounts.get(bot.id)! }
      : {}),
    ...(approvalCounts.has(bot.id) ? { awaitingApproval: approvalCounts.get(bot.id)! } : {}),
    // One cluster seat per Bot: centred beneath the gateway node, spread on
    // the CLUSTER_SPREAD arc in roster order, so the same roster always folds
    // to the same cluster.
    x: live.x + (CLUSTER_SPREAD * (index - (roster.length - 1) / 2)) / width,
    y: live.y + CLUSTER_DROP,
  }));
  const edges = bots.map((bot) => ({
    kind: 'gateway-bot' as const,
    gatewayId: live.gatewayId,
    botId: bot.botId,
  }));

  // Routine arcs — one per cron job, gateway→Bot by `parseRoutineName`'s own
  // read, verdict `describeCronHealth`'s own words. An unattributed job still
  // emits (the routine exists) but names nobody.
  const routines: ConstellationRoutineArc[] = cronJobs.map((job) => ({
    kind: 'routine' as const,
    gatewayId: live.gatewayId,
    botId: attributedBotId(parseRoutineName(job.name ?? '').botId),
    verdict: describeCronHealth(job),
  }));

  return { gateways, bots, edges, routines, ring };
}
