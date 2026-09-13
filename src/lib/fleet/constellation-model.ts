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

// ─── Render geometry (slice 2) ────────────────────────────────────────────
// The Skia layer and the plain fallback draw ONE layout, so the map is the
// same picture on either path and neither works out the graph a second time.
// The model owns the truth classes; this owns only the scale.

export const CONSTELLATION_NODE_RADIUS = 9;

export type ConstellationLayoutNode = ConstellationNode & { x: number; y: number };

export type ConstellationLayoutEdge = {
  id: string;
  from: string;
  to: string;
  kind: 'hosts';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type ConstellationLayout = {
  size: number;
  nodes: ConstellationLayoutNode[];
  edges: ConstellationLayoutEdge[];
  empty: boolean;
};

/** Fit the fixed model into a square of `size`, preserving its shape. */
export function constellationLayout(model: ConstellationModel, size: number): ConstellationLayout {
  const safeSize = Number.isFinite(size) && size > 0 ? size : 0;
  const scale = safeSize / CONSTELLATION_WIDTH;
  const nodes: ConstellationLayoutNode[] = model.nodes.map((node) => ({
    ...node,
    x: node.x * scale,
    y: node.y * scale,
  }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: ConstellationLayoutEdge[] = [];
  for (const edge of model.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    edges.push({
      id: `${edge.from}->${edge.to}`,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
    });
  }
  return { size: safeSize, nodes, edges, empty: model.empty };
}

/**
 * How long ago a saved gateway was last probed, as the map's one date. A
 * stamp in the future is "just now" — a clock skew must not read as a
 * negative age.
 */
export function relativeLastSeenCopy(at: number, now: number): string {
  const deltaMs = Math.max(0, now - at);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * What a screen reader announces for one node. The truth class leads: a live
 * gateway is `live`, a saved one is `last seen` (or `offline` when it was
 * never probed) — a down gateway can never be voiced as live.
 */
export function constellationNodeAccessibilityLabel(node: ConstellationNode): string {
  const parts: string[] = [node.label];
  if (node.kind === 'gateway') {
    parts.push(node.live ? 'live' : node.lastSeenAt !== undefined ? 'last seen' : 'offline');
  }
  for (const badge of node.badges) {
    const label = badge.label.toLowerCase();
    if (!parts.some((part) => part.toLowerCase() === label)) parts.push(label);
  }
  return parts.join(', ');
}

/** The empty fleet still says something dignified. */
export function constellationEmptyCopy(): { title: string; description: string } {
  return {
    title: 'No gateways yet',
    description: 'Add a gateway and its Bots will appear on the map.',
  };
}
