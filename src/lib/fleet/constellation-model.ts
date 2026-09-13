// ─── Fleet constellation: the pure graph ──────────────────────────────────
// D2 (`FUTURE-ITEMS.md`): a live map of the operator's fleet. Versutus holds
// ONE live gateway connection, so the model renders two truth classes and
// never blurs them: the connected gateway is live; a saved gateway is dimmed
// and dated from the last probe. The Skia layer draws only what this emits —
// no layout decision lives in a view.
//
// Pure and deterministic: same input, same graph. Empty fleets return an
// `empty` model rather than an empty sky.

export const CONSTELLATION_WIDTH = 640;
export const CONSTELLATION_HEIGHT = 640;

const CENTER_X = CONSTELLATION_WIDTH / 2;
const CENTER_Y = CONSTELLATION_HEIGHT / 2;
const GATEWAY_RADIUS = 210;
const SINGLE_GATEWAY_Y = CENTER_Y - 120;
const BOT_ROW_OFFSET = 72;
const BOT_SPACING = 96;

export type FleetGatewayInput = { id: string; name?: string };
export type FleetReachability = Record<string, { lastProbeAt?: number } | undefined>;
export type FleetBotInput = { id: string; displayName?: string };
export type FleetRunInput = { id: string; botId?: string; status: string };
export type FleetApprovalInput = { botId?: string };

export type ConstellationInput = {
  profiles: FleetGatewayInput[];
  connectedGatewayId?: string | null;
  reachability?: FleetReachability;
  /** The connected gateway's roster; the only one this device can read. */
  roster?: FleetBotInput[];
  cronJobs?: unknown[];
  activityRuns?: FleetRunInput[];
  pendingApprovals?: FleetApprovalInput[];
};

export type ConstellationBadge = {
  label: string;
  tone: 'success' | 'accent' | 'danger' | 'neutral';
};

export type ConstellationNode = {
  id: string;
  kind: 'gateway' | 'bot';
  gatewayId: string;
  label: string;
  x: number;
  y: number;
  live: boolean;
  lastSeenAt?: number;
  badges: ConstellationBadge[];
};

export type ConstellationEdge = { from: string; to: string; kind: 'hosts' };

export type ConstellationModel = {
  nodes: ConstellationNode[];
  edges: ConstellationEdge[];
  width: number;
  height: number;
  empty: boolean;
};

const EMPTY: ConstellationModel = {
  nodes: [],
  edges: [],
  width: CONSTELLATION_WIDTH,
  height: CONSTELLATION_HEIGHT,
  empty: true,
};

export function constellationModel(input: ConstellationInput): ConstellationModel {
  const profiles = input.profiles ?? [];
  if (profiles.length === 0) return EMPTY;

  const runningBots = new Set(
    (input.activityRuns ?? [])
      .filter((run) => run.status === 'running' && typeof run.botId === 'string')
      .map((run) => run.botId as string),
  );
  const approvalsByBot = new Map<string, number>();
  for (const approval of input.pendingApprovals ?? []) {
    if (typeof approval.botId !== 'string' || !approval.botId) continue;
    approvalsByBot.set(approval.botId, (approvalsByBot.get(approval.botId) ?? 0) + 1);
  }

  const nodes: ConstellationNode[] = [];
  const edges: ConstellationEdge[] = [];

  profiles.forEach((profile, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / profiles.length;
    const x = profiles.length === 1 ? CENTER_X : CENTER_X + GATEWAY_RADIUS * Math.cos(angle);
    const y = profiles.length === 1 ? SINGLE_GATEWAY_Y : CENTER_Y + GATEWAY_RADIUS * Math.sin(angle);
    const live = profile.id === input.connectedGatewayId;
    const lastSeenAt = input.reachability?.[profile.id]?.lastProbeAt;

    const badges: ConstellationBadge[] = live
      ? [{ label: 'Live', tone: 'success' }]
      : lastSeenAt !== undefined
        ? [{ label: 'Last seen', tone: 'neutral' }]
        : [{ label: 'Offline', tone: 'neutral' }];

    const gatewayNode: ConstellationNode = {
      id: `gateway:${profile.id}`,
      kind: 'gateway',
      gatewayId: profile.id,
      label: profile.name?.trim() || profile.id,
      x,
      y,
      live,
      badges,
    };
    if (lastSeenAt !== undefined) gatewayNode.lastSeenAt = lastSeenAt;
    nodes.push(gatewayNode);

    if (!live) return;
    const roster = input.roster ?? [];
    roster.forEach((bot, botIndex) => {
      const botX = x + (botIndex - (roster.length - 1) / 2) * BOT_SPACING;
      const botY = y + BOT_ROW_OFFSET;
      const botBadges: ConstellationBadge[] = [];
      if (runningBots.has(bot.id)) botBadges.push({ label: 'Running', tone: 'accent' });
      const approvals = approvalsByBot.get(bot.id) ?? 0;
      if (approvals > 0) {
        botBadges.push({
          label: `${approvals} approval${approvals === 1 ? '' : 's'}`,
          tone: 'danger',
        });
      }
      const id = `bot:${profile.id}:${bot.id}`;
      nodes.push({
        id,
        kind: 'bot',
        gatewayId: profile.id,
        label: bot.displayName?.trim() || bot.id,
        x: botX,
        y: botY,
        live: true,
        badges: botBadges,
      });
      edges.push({ from: `gateway:${profile.id}`, to: id, kind: 'hosts' });
    });
  });

  return {
    nodes,
    edges,
    width: CONSTELLATION_WIDTH,
    height: CONSTELLATION_HEIGHT,
    empty: false,
  };
}
