// ─── Fleet constellation: the pure graph ──────────────────────────────────
// D2 (`FUTURE-ITEMS.md`): a live map of the operator's fleet. Versutus holds
// ONE live gateway connection, so the model renders two truth classes and
// never blurs them: the connected gateway is live; a saved gateway is dimmed
// and dated from the last probe. The painter draws only what this emits —
// no layout decision lives in a view.
//
// Pure and deterministic: same input, same graph. Empty fleets return an
// `empty` model rather than an empty sky.
//
// The map is a rectangle now, not a fixed square: the model emits a graph in
// a 640×640 design space and `constellationLayout` fits that graph into
// whatever box the screen offers, choosing the larger axis to fill. A fleet
// of any width fits on screen; labels no longer bleed off the edges.

export const CONSTELLATION_WIDTH = 640;
export const CONSTELLATION_HEIGHT = 640;

const CENTER_X = CONSTELLATION_WIDTH / 2;
const CENTER_Y = CONSTELLATION_HEIGHT / 2;
const GATEWAY_RADIUS = 210;
const SINGLE_GATEWAY_Y = CENTER_Y - 120;
const BOT_ROW_OFFSET = 72;
// The widest row (9 Bots at full spacing) would land ±384 from center — past
// the design edge. The row compacts instead: spacing shrinks to the width a
// real roster can occupy, so every Bot star stays inside the sky.
const BOT_SPACING = 96;
const DESIGN_MARGIN = 32;

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
  /** On a Bot node, the roster id a tap opens. Gateway nodes carry none. */
  botId?: string;
  /** One live run name, when a run is in flight — the map links the actor. */
  runningRunName?: string;
};

export type ConstellationEdge = { from: string; to: string; kind: 'hosts' };

export type ConstellationModel = {
  nodes: ConstellationNode[];
  edges: ConstellationEdge[];
  width: number;
  height: number;
  empty: boolean;
  /** Fleet health at a glance — what the HUD line under the map reads. */
  summary: {
    gateways: number;
    live: boolean;
    bots: number;
    running: number;
    approvals: number;
  };
};

const EMPTY: ConstellationModel = {
  nodes: [],
  edges: [],
  width: CONSTELLATION_WIDTH,
  height: CONSTELLATION_HEIGHT,
  empty: true,
  summary: { gateways: 0, live: false, bots: 0, running: 0, approvals: 0 },
};

export function constellationModel(input: ConstellationInput): ConstellationModel {
  const profiles = input.profiles ?? [];
  if (profiles.length === 0) return EMPTY;

  // A live run and its Bot: the map shows what each star is doing, one
  // running name at most per Bot — the newest run wins, order is the input's.
  const runningRuns = new Map<string, string>();
  for (const run of input.activityRuns ?? []) {
    if (run.status !== 'running' || typeof run.botId !== 'string' || !run.botId) continue;
    if (!runningRuns.has(run.botId)) runningRuns.set(run.botId, '');
  }
  const runningBots = new Set(runningRuns.keys());

  const approvalsByBot = new Map<string, number>();
  for (const approval of input.pendingApprovals ?? []) {
    if (typeof approval.botId !== 'string' || !approval.botId) continue;
    approvalsByBot.set(approval.botId, (approvalsByBot.get(approval.botId) ?? 0) + 1);
  }

  const nodes: ConstellationNode[] = [];
  const edges: ConstellationEdge[] = [];
  let botsTotal = 0;
  let runningTotal = 0;
  let approvalsTotal = 0;

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
      // The row compacts to the design sky: at big rosters the full spacing
      // would push the outer Bots past the edge, so spacing shrinks to fit.
      const usable = CONSTELLATION_WIDTH - 2 * DESIGN_MARGIN;
      const spacing = Math.min(BOT_SPACING, roster.length > 1 ? usable / (roster.length - 1) : BOT_SPACING);
      const botX = Math.min(
        CONSTELLATION_WIDTH - DESIGN_MARGIN,
        Math.max(DESIGN_MARGIN, x + (botIndex - (roster.length - 1) / 2) * spacing),
      );
      const botY = y + BOT_ROW_OFFSET;
      const botBadges: ConstellationBadge[] = [];
      let runningRunName: string | undefined;
      if (runningBots.has(bot.id)) {
        botBadges.push({ label: 'Running', tone: 'accent' });
        runningRunName = runningRuns.get(bot.id) || undefined;
      }
      const approvals = approvalsByBot.get(bot.id) ?? 0;
      approvalsTotal += approvals;
      if (approvals > 0) {
        botBadges.push({
          label: `${approvals} approval${approvals === 1 ? '' : 's'}`,
          tone: 'danger',
        });
      }
      if (runningBots.has(bot.id)) runningTotal += 1;
      botsTotal += 1;
      const id = `bot:${profile.id}:${bot.id}`;
      const node: ConstellationNode = {
        id,
        kind: 'bot',
        gatewayId: profile.id,
        label: bot.displayName?.trim() || bot.id,
        x: botX,
        y: botY,
        live: true,
        badges: botBadges,
        botId: bot.id,
      };
      if (runningRunName) node.runningRunName = runningRunName;
      nodes.push(node);
      edges.push({ from: `gateway:${profile.id}`, to: id, kind: 'hosts' });
    });
  });

  return {
    nodes,
    edges,
    width: CONSTELLATION_WIDTH,
    height: CONSTELLATION_HEIGHT,
    empty: false,
    summary: {
      gateways: profiles.length,
      live: profiles.some((profile) => profile.id === input.connectedGatewayId),
      bots: botsTotal,
      running: runningTotal,
      approvals: approvalsTotal,
    },
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
  width: number;
  height: number;
  nodes: ConstellationLayoutNode[];
  edges: ConstellationLayoutEdge[];
  empty: boolean;
  summary: ConstellationModel['summary'];
};

/**
 * Fit the model's design square into a `width × height` box, scaling to the
 * tighter-fitting axis and centering on the other. A node never leaves the
 * box: this is what keeps every profile on screen at any fleet width.
 */
export function constellationLayout(
  model: ConstellationModel,
  width: number,
  height = width,
): ConstellationLayout {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 0;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 0;
  // Null-size callers (the very first onLayout) get valid zeros rather than a
  // NaN graph; the view only paints once it has a real measurement.
  if (safeWidth === 0 || safeHeight === 0) {
    return {
      size: 0,
      width: safeWidth,
      height: safeHeight,
      nodes: [],
      edges: [],
      empty: model.empty,
      summary: model.summary,
    };
  }
  const scale = Math.min(safeWidth / CONSTELLATION_WIDTH, safeHeight / CONSTELLATION_HEIGHT);
  // The graph is a fixed square; squeeze the leftover axis by centering.
  const drawnWidth = CONSTELLATION_WIDTH * scale;
  const drawnHeight = CONSTELLATION_HEIGHT * scale;
  const dx = (safeWidth - drawnWidth) / 2;
  const dy = (safeHeight - drawnHeight) / 2;
  const nodes: ConstellationLayoutNode[] = model.nodes.map((node) => ({
    ...node,
    x: node.x * scale + dx,
    y: node.y * scale + dy,
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
  return {
    size: safeWidth,
    width: safeWidth,
    height: safeHeight,
    nodes,
    edges,
    empty: model.empty,
    summary: model.summary,
  };
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

/** The HUD's one line, from the model's own summary — no view arithmetic. */
export function constellationSummaryCopy(summary: ConstellationModel['summary']): string {
  if (summary.gateways === 0) return 'No gateways yet';
  if (!summary.live) {
    return summary.gateways === 1
      ? '1 gateway saved — none connected'
      : `${summary.gateways} gateways saved — none connected`;
  }
  const bots = summary.bots === 1 ? '1 Bot' : `${summary.bots} Bots`;
  const rest: string[] = [];
  if (summary.running > 0) rest.push(`${summary.running} running`);
  if (summary.approvals > 0) rest.push(`${summary.approvals} approvals waiting`);
  return rest.length > 0 ? `${bots} · ${rest.join(' · ')}` : `${bots} · all quiet`;
}
