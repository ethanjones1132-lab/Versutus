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

import { describeCronHealth, type CronHealth } from '@/lib/gateway/cron';
import { parseRoutineName } from '@/lib/gateway/routines';
import type { GatewayCapabilitySnapshot } from '@/lib/gateway/types';
import type { FleetRosterReadStatus } from '@/lib/fleet/roster-read';
import type { FleetRoutineReadStatus } from '@/lib/fleet/routine-read';

export const CONSTELLATION_WIDTH = 640;
export const CONSTELLATION_HEIGHT = 640;

const CENTER_X = CONSTELLATION_WIDTH / 2;
const CENTER_Y = CONSTELLATION_HEIGHT / 2;
const GATEWAY_RADIUS = 210;
const SINGLE_GATEWAY_Y = CENTER_Y - 120;
const BOT_ROW_OFFSET = 72;
// Bots never compress below a label's width: a roster too wide for one row
// wraps into the next, BOT_ROW_GAP further down. BOT_LABEL_WIDTH is the room a
// Bot's name is given, so two neighbours BOT_SPACING apart cannot overlap.
const BOT_SPACING = 104;
const BOT_LABEL_WIDTH = 96;
const BOT_ROW_GAP = 64;

export type FleetGatewayInput = { id: string; name?: string };
export type FleetReachability = Record<string, {
  state?: 'reachable' | 'unreachable' | 'checking' | 'unknown';
  lastProbeAt?: number;
  latencyMs?: number;
  error?: string;
} | undefined>;
export type FleetBotInput = { id: string; displayName?: string };
export type FleetRunInput = { id: string; botId?: string; status: string };
export type FleetApprovalInput = { botId?: string };

export type ConstellationInput = {
  profiles: FleetGatewayInput[];
  connectedGatewayId?: string | null;
  reachability?: FleetReachability;
  capabilitySnapshot?: GatewayCapabilitySnapshot;
  /** The connected gateway's roster; the only one this device can read. */
  roster?: FleetBotInput[];
  rosterReadStatus?: FleetRosterReadStatus;
  cronJobs?: unknown[];
  routineReadStatus?: FleetRoutineReadStatus;
  activityRuns?: FleetRunInput[];
  pendingApprovals?: FleetApprovalInput[];
};

export type ConstellationBadge = {
  label: string;
  action?: 'approval';
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
  probeDetail?: string;
  capabilityDetail?: string;
  badges: ConstellationBadge[];
  /** On a Bot node, the roster id a tap opens. Gateway nodes carry none. */
  botId?: string;
  /** One live run name, when a run is in flight — the map links the actor. */
  runningRunName?: string;
  /**
   * The width, in design units, this node's label may occupy. Bots carry it
   * because their rows are packed to exactly this budget; a gateway leaves it
   * to the view's default box.
   */
  labelWidth?: number;
};

export type ConstellationEdge = { from: string; to: string; kind: 'hosts' | 'routine' };

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
    routineReadStatus?: FleetRoutineReadStatus;
    rosterReadStatus?: FleetRosterReadStatus;
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

function capabilityReadinessCopy(snapshot?: GatewayCapabilitySnapshot): string {
  if (!snapshot || snapshot.status === 'offline') return 'Capabilities unreported';
  if (snapshot.status === 'warming') return 'Capabilities warming';
  const counted = snapshot.groups.filter((group) => group.status !== 'undeclared');
  if (counted.length === 0) return 'Capabilities unreported';
  const ready = counted.filter((group) => group.status === 'ready' || group.status === 'available').length;
  const tally = `${ready}/${counted.length}`;
  if (snapshot.status === 'stale') return `Capabilities stale · ${tally} last known ready`;
  if (snapshot.status === 'partial') return `Capabilities partial · ${tally} ready`;
  return `Capabilities ${tally} ready`;
}

export function constellationModel(input: ConstellationInput): ConstellationModel {
  const profiles = input.profiles ?? [];
  if (profiles.length === 0) return EMPTY;

  // A live run and its Bot: the map shows what each star is doing, one
  // running name at most per Bot — the newest run wins, order is the input's.
  const runningRuns = new Map<string, string>();
  // The failure count per Bot is the same per-run status the scorecard's
  // `scorecardFate` reads: only `failed` counts, never cancelled (the
  // operator's own stop), unresolved (a fate never learned) or anything
  // unsettled. A run naming no Bot lands nowhere — the same discipline the
  // scorecard applies to a row with no `botId`.
  const failuresByBot = new Map<string, number>();
  for (const run of input.activityRuns ?? []) {
    if (run.status !== 'failed' || typeof run.botId !== 'string' || !run.botId) continue;
    failuresByBot.set(run.botId, (failuresByBot.get(run.botId) ?? 0) + 1);
  }
  for (const run of input.activityRuns ?? []) {
    if (run.status !== 'running' || typeof run.botId !== 'string' || !run.botId) continue;
    if (!runningRuns.has(run.botId)) runningRuns.set(run.botId, '');
  }
  const runningBots = new Set(runningRuns.keys());

  // The routine read the connected gateway reported — described, not re-worded.
  // A gateway that named no jobs is a map with no arcs, not a map that guesses.
  const routineReadStatus = input.routineReadStatus ?? 'unreported';
  const routineTonesByBot = input.cronJobs ? constellationRoutines(input.cronJobs) : null;
  const routineTonesFor = (botId: string): CronHealth['tone'][] | undefined =>
    routineTonesByBot?.get(botId);

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
    const probe = input.reachability?.[profile.id];
    const lastSeenAt = probe?.lastProbeAt;
    const probeLabel = probe?.state === 'reachable' ? 'Reachable'
      : probe?.state === 'unreachable' ? 'Unreachable'
        : probe?.state === 'checking' ? 'Checking' : 'Unknown';
    const badges: ConstellationBadge[] = live
      ? [{ label: 'Live', tone: 'success' }]
      : [{ label: probeLabel, tone: 'neutral' }];

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
    if (lastSeenAt !== undefined && Number.isFinite(lastSeenAt)) gatewayNode.lastSeenAt = lastSeenAt;
    const probeDetail = live ? undefined : savedProbeDetail(probe);
    if (probeDetail) gatewayNode.probeDetail = probeDetail;
    if (live) gatewayNode.capabilityDetail = capabilityReadinessCopy(input.capabilitySnapshot);
    nodes.push(gatewayNode);

    if (!live) return;
    const rosterWarning: ConstellationBadge | undefined = input.rosterReadStatus && input.rosterReadStatus !== 'ready'
      ? { label: `Roster ${input.rosterReadStatus}`, tone: 'neutral' } : undefined;
    if (rosterWarning) badges.push(rosterWarning);
    const roster = input.roster ?? [];
    // Bots wrap into rows beneath their gateway at a spacing a label can own.
    // The row used to compress to fit the sky instead: at 15 Bots that was 41
    // design units apart for labels drawn 148 wide, and every name overlapped
    // into one unreadable smear (2026-09-16). A row now holds only as many
    // Bots as fit at BOT_SPACING with their labels inside the sky, and the
    // rest start the next row down.
    const botsPerRow = Math.max(
      1,
      Math.floor((CONSTELLATION_WIDTH - BOT_LABEL_WIDTH) / BOT_SPACING) + 1,
    );
    roster.forEach((bot, botIndex) => {
      const row = Math.floor(botIndex / botsPerRow);
      const rowStart = row * botsPerRow;
      const rowCount = Math.min(botsPerRow, roster.length - rowStart);
      const rowWidth = (rowCount - 1) * BOT_SPACING;
      // Centre the row under the gateway, then slide the whole row (never
      // squeeze it) so its outer labels stay on the sky.
      const rowLeft = Math.min(
        CONSTELLATION_WIDTH - BOT_LABEL_WIDTH / 2 - rowWidth,
        Math.max(BOT_LABEL_WIDTH / 2, x - rowWidth / 2),
      );
      const botX = rowLeft + (botIndex - rowStart) * BOT_SPACING;
      const botY = y + BOT_ROW_OFFSET + row * BOT_ROW_GAP;
      const botBadges: ConstellationBadge[] = rosterWarning ? [rosterWarning] : [];
      let runningRunName: string | undefined;
      if (runningBots.has(bot.id)) {
        botBadges.push({ label: 'Running', tone: 'accent' });
        runningRunName = runningRuns.get(bot.id) || undefined;
      }
      // The failed-count badge: the same run-derived fact the Activity
      // scorecard folds (`only a run this device saw reached `failed``), so
      // the map and that card cannot disagree about what a failure is. A
      // Bot with no failed runs gets no badge rather than a `0 failed` one.
      const failures = failuresByBot.get(bot.id) ?? 0;
      if (failures > 0) {
        botBadges.push({
          label: `${failures} failed`,
          tone: 'danger',
        });
      }
      const approvals = approvalsByBot.get(bot.id) ?? 0;
      approvalsTotal += approvals;
      if (approvals > 0) {
        botBadges.push({
          label: `${approvals} approval${approvals === 1 ? '' : 's'}`,
          tone: 'danger',
          action: 'approval',
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
        labelWidth: BOT_LABEL_WIDTH,
        live: true,
        badges: botBadges,
        botId: bot.id,
      };
      if (runningRunName) node.runningRunName = runningRunName;
      nodes.push(node);
      edges.push({ from: `gateway:${profile.id}`, to: id, kind: 'hosts' });
      // The routine arc: one per gateway–Bot pairing, deduped — the map says
      // "this Bot's routines schedule through this gateway", not one thread
      // per job. The arc's label is the worst verdict's tone, the same words
      // the Routine surfaces print, and a Bot the read named no job for gets
      // no arc rather than an empty-looking one.
      const routineTones = routineTonesFor(bot.id);
      if (routineTones?.length) {
        const worst = worstRoutineTone(routineTones);
        if (worst) {
          const badge = routineToneBadge(worst);
          botBadges.push(routineReadStatus === 'ready' ? badge : {
            ...badge,
            label: `${badge.label} · ${routineReadStatus}`,
          });
        }
        edges.push({ from: `gateway:${profile.id}`, to: id, kind: 'routine' });
      } else if (routineReadStatus !== 'ready') {
        botBadges.push({ label: `routines ${routineReadStatus}`, tone: 'neutral' });
      }
    });

    // A job whose name attributes no Bot is still a word the gateway said:
    // its arc lands on nobody — but the map shows the worst verdict on the
    // Gateway node rather than a zero-length self-edge. A Bot is never guessed.
    const unownedTones = routineTonesByBot?.get(null);
    if (unownedTones && unownedTones.length > 0) {
      const worst = worstRoutineTone(unownedTones);
      if (worst) {
        const badge = routineToneBadge(worst);
        gatewayNode.badges.push(
          routineReadStatus === 'ready' ? badge : { ...badge, label: `${badge.label} · ${routineReadStatus}` },
        );
      }
    }
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
      routineReadStatus,
      rosterReadStatus: input.rosterReadStatus,
    },
  };
}

function savedProbeDetail(probe: FleetReachability[string]): string | undefined {
  if (probe?.state === 'reachable') {
    const latency = probe.latencyMs;
    if (typeof latency !== 'number' || !Number.isFinite(latency) || latency < 0) return undefined;
    return latency > 99_999 ? '99999+ ms' : `${Math.round(latency)} ms`;
  }
  if (probe?.state !== 'unreachable' || !probe.error?.trim()) return undefined;
  // Probe failures may contain a URL or a platform exception. Classify them
  // rather than copying raw diagnostics into the map or spoken label.
  const error = probe.error;
  const http = /^Gateway returned HTTP ([1-5]\d{2})$/.exec(error);
  if (http) return `HTTP ${http[1]}`;
  if (/timed out|timeout/i.test(error)) return 'Probe timed out';
  if (/network|fetch|connect|enotfound|getaddrinfo/i.test(error)) return 'Could not reach the gateway';
  return 'Probe failed';
}

// ─── Routine arcs (D2 build 2) ────────────────────────────────────────────
// The map is a lens over work the host already reported, and the scheduled
// work is one of its four surfaces. A routine is an ARC, not a node: it runs
// between the gateway that schedules it and the Bot it belongs to.

const TONE_RANK: readonly CronHealth['tone'][] = ['error', 'warn', 'unknown', 'ok', 'off'];

/**
 * The worst verdict among a Bot's routines, in `describeCronHealth`'s own
 * vocabulary (`scorecard.ts`'s rank, names attached to their own order):
 * a failure is what the operator acts on, an off-on-purpose job is not
 * unhealthy, and a job that never ran is UNKNOWN rather than a reassuring
 * claim. No tones at all is no facts — never `ok`.
 */
export function worstRoutineTone(
  tones: readonly CronHealth['tone'][],
): CronHealth['tone'] | undefined {
  let worst: CronHealth['tone'] | undefined;
  for (const tone of tones) {
    const rank = TONE_RANK.indexOf(tone);
    if (rank === -1) continue;
    if (worst === undefined || rank < TONE_RANK.indexOf(worst)) worst = tone;
  }
  return worst;
}

/**
 * Fold the gateway's cron read into per-Bot routine facts. Attribution is the
 * Bot the job's own name carries (`[bot:<name>]` — the convention
 * `routineName` writes and `parseRoutineName` reads, read here the same way
 * `scorecardRoutineHealth` reads it): a job whose name attributes no Bot gets
 * an arc to nobody rather than a guessed Bot. A row this fold cannot even
 * read an id from is dropped, the way `routineJobsFromList` drops one — a
 * malformed row cannot put an arc into the sky.
 */
export function constellationRoutines(
  jobs: readonly unknown[],
): ReadonlyMap<string | null, CronHealth['tone'][]> {
  const tonesByBot = new Map<string | null, CronHealth['tone'][]>();
  for (const job of jobs) {
    if (typeof job !== 'object' || job === null || Array.isArray(job)) continue;
    const record = job as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id) continue;
    const ownedName =
      typeof record.name === 'string' && record.name.trim().length > 0
        ? record.name
        : id;
    // An empty bracket (`[bot:]`) is a tag with no owner in it, not a Bot
    // whose id is empty — the parse answers no Bot, and so does this fold.
    const parsed = parseRoutineName(ownedName);
    const botId = parsed.botId && parsed.botId.length > 0 ? parsed.botId : null;
    // The health verdict is the gateway's own vocabulary — never re-worded
    // here: the tone arrives, the words stay behind.
    const tone = describeCronHealth({
      id,
      title: typeof record.title === 'string' ? record.title : id,
      name: typeof record.name === 'string' ? record.name : null,
      botId,
      paused: record.paused === true,
      running: record.running === true,
      lastStatus: typeof record.lastStatus === 'string' ? record.lastStatus : null,
      lastError: typeof record.lastError === 'string' ? record.lastError : null,
      lastDeliveryError:
        typeof record.lastDeliveryError === 'string' ? record.lastDeliveryError : null,
      cooldownReason: typeof record.cooldownReason === 'string' ? record.cooldownReason : null,
      failureStreak:
        typeof record.failureStreak === 'number' && Number.isFinite(record.failureStreak)
          ? record.failureStreak
          : 0,
    }).tone;
    const bucket = tonesByBot.get(botId);
    if (bucket) bucket.push(tone);
    else tonesByBot.set(botId, [tone]);
  }
  return tonesByBot;
}

/**
 * The badge a Bot star wears for its routines: the worst verdict's own word
 * (`describeCronHealth`'s label), so the map says what the Routine surfaces
 * say and two surfaces never describe one host state two ways. `unknown`
 * keeps its honesty — "Not run yet" is not a reassuring badge.
 */
export function routineToneBadge(
  tone: CronHealth['tone'],
): { label: string; tone: ConstellationBadge['tone'] } {
  switch (tone) {
    case 'error':
      return { label: 'routine failing', tone: 'danger' };
    case 'warn':
      return { label: 'routine behind', tone: 'accent' };
    case 'off':
      return { label: 'routine paused', tone: 'neutral' };
    case 'unknown':
      return { label: 'routine unreported', tone: 'neutral' };
    default:
      return { label: 'routines', tone: 'neutral' };
  }
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
  kind: 'hosts' | 'routine';
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
/**
 * The on-screen width a node's label box may take in a map drawn `boxSize`
 * wide. A Bot carries the label budget its row was packed to (design units),
 * scaled here to the screen; a node without one keeps the view's own default.
 * A fixed default box over tightly packed Bots is what overlapped every name.
 */
export function constellationNodeBoxWidth(
  node: Pick<ConstellationNode, 'labelWidth'>,
  boxSize: number,
  fallback: number,
): number {
  if (node.labelWidth === undefined || !Number.isFinite(boxSize) || boxSize <= 0) return fallback;
  return (node.labelWidth * boxSize) / CONSTELLATION_WIDTH;
}

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
 * gateway is `live`, a saved one carries its probe verdict and bounded
 * detail — a probe stamp alone never claims reachability.
 */
export function constellationNodeAccessibilityLabel(node: ConstellationNode): string {
  const parts: string[] = [node.label];
  if (node.kind === 'gateway') {
    parts.push(node.live ? 'live' : 'saved gateway');
  }
  for (const badge of node.badges) {
    const label = badge.label.toLowerCase();
    if (!parts.some((part) => part.toLowerCase() === label)) parts.push(label);
  }
  if (node.probeDetail) parts.push(node.probeDetail);
  if (node.capabilityDetail) parts.push(node.capabilityDetail);
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
  const rosterStatus = summary.rosterReadStatus;
  const bots = rosterStatus === 'unreported' || rosterStatus === 'unavailable'
    ? `Roster ${rosterStatus}`
    : rosterStatus === 'stale'
      ? `${summary.bots} last-known Bot${summary.bots === 1 ? '' : 's'}`
      : summary.bots === 1 ? '1 Bot' : `${summary.bots} Bots`;
  const rest: string[] = [];
  if (rosterStatus === 'stale') rest.push('Roster stale');
  if (summary.running > 0) rest.push(`${summary.running} running`);
  if (summary.approvals > 0) rest.push(`${summary.approvals} approvals waiting`);
  if (summary.routineReadStatus && summary.routineReadStatus !== 'ready') {
    rest.push(`routines ${summary.routineReadStatus}`);
  }
  if (rest.length > 0) return `${bots} · ${rest.join(' · ')}`;
  return rosterStatus === 'unreported' || rosterStatus === 'unavailable' ? bots : `${bots} · all quiet`;
}
