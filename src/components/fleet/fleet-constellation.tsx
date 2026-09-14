/**
 * The fleet drawer: what the constellation screen paints, and nothing else.
 *
 * One absolute-view renderer over the pure fold's shares — the model answers
 * positions in shares of the canvas (constellation-model.ts) and the drawer
 * multiplies them by its measured canvas, never re-deriving a share of its
 * own.
 *
 * The two truth classes draw differently — the visual contract that a saved
 * gateway never borrows the live gateway's tone — and a saved node's only
 * extra words come from `lastSeenCopy`, which says nothing when the
 * reachability record carries no stamp to say.
 *
 * The Bot cluster hangs beneath the live gateway only (the fold answers the
 * seats) and one `gateway-bot` edge joins the gateway to each seat, drawn
 * from the fold's own geometry. A tap on a seat runs through
 * `fleetBotTapAction` before it routes anything: a routable Bot rides the
 * provider's own `openBot` then the route to `/chat`, a drawn-but-unroutable
 * Bot answers its routing verdict at the seat — the roster's own words,
 * never silently dead — and a waiting-approval Bot is drawn distinct.
 */

import { memo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Card, PressableScale, Text as UiText } from '@/components/ui';
import { fleetBotTapAction } from '@/lib/fleet/bot-tap';
import {
  foldConstellation,
  type ConstellationModel,
} from '@/lib/fleet/constellation-model';
import { botChipRoutingTag } from '@/lib/gateway/bots';
import { constellationStatusCopy, lastSeenCopy } from '@/lib/fleet/last-seen-label';
import { Palette, Radius, Spacing } from '@/constants/tokens';
import type { PublicBot } from '@/lib/gateway/bots';
import type { GatewayProfile } from '@/lib/gateway/types';

const CANVAS_ASPECT = 4 / 3;

type DrawerProfiles = GatewayProfile[];
type DrawerReachability = Parameters<typeof foldConstellation>[0]['reachability'];

/**
 * The two node tones. The live node uses the accent the home hero already
 * rings with; a saved node is dimmed (`textTertiary`), never green, never
 * accent — the FUTURE-ITEMS §D2 rule, drawn rather than said.
 */
const LIVE_TONE = {
  dot: Palette.accentWarm,
  label: Palette.textPrimary,
  sub: Palette.textSecondary,
  border: Palette.borderStrong,
} as const;
const SAVED_TONE = {
  dot: Palette.textTertiary,
  label: Palette.textTertiary,
  sub: Palette.textTertiary,
  border: Palette.borderSubtle,
} as const;

/**
 * The label pair the node card shows beside its dot: the status copy is the
 * class's own vocabulary and the last-seen line is the record's own stamp,
 * rendered only when a stamp exists.
 */
function nodeLines(node: ConstellationModel['gateways'][number]): {
  status: string;
  lastSeen?: string;
} {
  return {
    status: constellationStatusCopy(node.truth),
    lastSeen: node.reachability ? lastSeenCopy(node.reachability) : undefined,
  };
}

/**
 * One Bot seat's words: the detail line is the roster's own verdict
 * (`botChipRoutingTag`, the row vocabulary the roster screen already shows)
 * for a drawn-but-unroutable Bot, and plain "Bot" for a routable one —
 * no word the roster did not say.
 */
function botDetail(bot: ConstellationModel['bots'][number]): string {
  if (bot.routable) return 'Bot';
  return botChipRoutingTag(bot as unknown as PublicBot) || 'Not routable';
}

export const ConstellationCanvas = memo(function ConstellationCanvas({
  width,
  height,
  now,
  profiles,
  reachability,
  activeGatewayId,
  status,
  roster,
  connected,
  openBot,
  navigateToChat,
  onGatewayPress,
}: {
  /** Measured canvas width; `null` until the first onLayout lands. */
  width: number | null;
  height: number | null;
  now: number;
  profiles: DrawerProfiles;
  reachability: DrawerReachability;
  activeGatewayId: string | null;
  status: Parameters<typeof foldConstellation>[0]['status'];
  /** The connected gateway's own roster, handed in — the cluster's seats. */
  roster?: PublicBot[];
  /** The cluster's gateway is connected — the tap's gate, handed by the screen. */
  connected?: boolean;
  /**
   * The provider's own `openBot` (the seam the deep-link landed-open path
   * rides) and the route to `/chat` a landed open follows. The drawer folds
   * the tap through `fleetBotTapAction` and never routes on a false open.
   */
  openBot?: (botId: string) => Promise<boolean>;
  navigateToChat?: () => void;
  /**
   * The connect affordance the two-truth map exists to drive: tapping a node
   * hands its profile up; the screen decides what the fold's two classes
   * mean for the tap — the live node is not a button to itself.
   */
  onGatewayPress?: (profile: GatewayProfile) => void;
}) {
  // The seat whose detail words are showing — a detail tap on a
  // drawn-but-unroutable Bot surfaces its verdict at the seat, one at a time.
  const [detailBotId, setDetailBotId] = useState<string | null>(null);
  // A canvas that has not answered layout yet answers an empty ring: the map
  // appears on the first measured frame instead of scattering off-canvas.
  if (width === null || height === null || width <= 0 || height <= 0) {
    return <View style={[styles.canvas, styles.canvasEmpty]} />;
  }
  const model = foldConstellation({
    profiles,
    reachability,
    activeGatewayId,
    status,
    roster: roster ?? [],
    width,
    height,
    now,
  });
  const liveNode = model.gateways.find((node) => node.truth === 'live');

  const handleBotPress = (bot: ConstellationModel['bots'][number]) => {
    const action = fleetBotTapAction({
      bot: { botId: bot.botId, routable: bot.routable },
      connected: connected ?? false,
    });
    if (action.kind === 'open' && openBot && navigateToChat) {
      void openBot(bot.botId)
        .then((opened) => {
          // Only a landed open routes — the landed-open contract openBot's
          // own callers honor; a refusal is a detail at the seat, not a
          // navigation the provider already refused.
          if (opened) navigateToChat();
        })
        .catch(() => setDetailBotId(bot.botId));
      return;
    }
    setDetailBotId(bot.botId);
  };

  return (
    <View style={[styles.canvas, { height: Math.max(240, width / CANVAS_ASPECT) }]}>
      {model.gateways.length > 0 ? (
        <View style={[styles.ring, ringStyle(model)]} />
      ) : null}
      {liveNode && model.bots.length > 0 ? (
        model.bots.map((bot) => (
          <EdgeLine
            key={bot.botId}
            from={{ x: liveNode.x * width, y: liveNode.y * height }}
            to={{ x: bot.x * width, y: bot.y * height }}
          />
        ))
      ) : null}
      {model.gateways.map((node) => {
        const tone = node.truth === 'live' ? LIVE_TONE : SAVED_TONE;
        const lines = nodeLines(node);
        // A tappable node is a PressableScale; the live node keeps
        // pointerEvents="none" — the connected gateway is not a button to
        // itself, the honesty the two-class map exists to hold.
        const tappable = node.truth === 'saved' && onGatewayPress !== undefined;
        const pressedProfile = profiles.find((profile) => profile.id === node.gatewayId);
        return (
          <PressableScale
            key={node.gatewayId}
            disabled={!tappable}
            onPress={() => tappable && pressedProfile && onGatewayPress(pressedProfile)}
            accessibilityRole={tappable ? 'button' : undefined}
            accessibilityLabel={
              tappable ? `Connect ${node.gatewayName}` : undefined
            }
            pointerEvents={tappable ? 'auto' : 'none'}
            style={[
              styles.node,
              {
                left: node.x * width,
                top: node.y * height,
                borderColor: tone.border,
              },
            ]}>
            <View style={[styles.dot, { backgroundColor: tone.dot }]} />
            <UiText variant="micro" numberOfLines={1} style={[styles.nodeName, { color: tone.label }]}>
              {node.gatewayName}
            </UiText>
            <Text style={[styles.nodeStatus, { color: tone.sub }]}>{lines.status}</Text>
            {lines.lastSeen ? (
              <Text style={[styles.nodeStatus, { color: tone.sub }]} numberOfLines={1}>
                {lines.lastSeen}
              </Text>
            ) : null}
            {tappable ? (
              <Text style={[styles.nodeStatus, { color: tone.label }]}>Connect…</Text>
            ) : null}
          </PressableScale>
        );
      })}
      {model.bots.map((bot) => {
        const waiting = (bot.awaitingApproval ?? 0) > 0;
        const pulsing = (bot.activityRuns ?? 0) > 0;
        // A waiting-approval seat borrows the live node's border — the model
        // flagged it as the alarm — while a quiet seat sits dimmed like the
        // saved ring and never borrows the accent for its own dot.
        const border = waiting ? Palette.borderStrong : Palette.borderSubtle;
        const isDetail = detailBotId === bot.botId;
        return (
          <PressableScale
            key={bot.botId}
            onPress={() => handleBotPress(bot)}
            accessibilityRole="button"
            accessibilityLabel={
              waiting ? `${bot.botName}, waiting for approval` : `Open ${bot.botName}`
            }
            style={[
              styles.botSeat,
              { left: bot.x * width, top: bot.y * height, borderColor: border },
            ]}>
            <View
              style={[
                styles.dot,
                {
                  backgroundColor: waiting ? LIVE_TONE.dot : LIVE_TONE.sub,
                  opacity: waiting || pulsing ? 1 : 0.55,
                },
              ]}
            />
            <UiText variant="micro" numberOfLines={1} style={[styles.nodeName, { color: Palette.textPrimary }]}>
              {bot.botName}
            </UiText>
            {isDetail ? (
              <Text style={[styles.nodeStatus, { color: Palette.textSecondary }]} numberOfLines={1}>
                {botDetail(bot)}
              </Text>
            ) : null}
            {waiting ? (
              <Text style={[styles.nodeStatus, { color: Palette.textSecondary }]} numberOfLines={1}>
                Waiting approval
              </Text>
            ) : null}
          </PressableScale>
        );
      })}
    </View>
  );
});

/**
 * One gateway→Bot edge: a hairline from the live node's seat to the Bot's
 * seat, drawn with the same left/top/right/transform units everything else
 * on this canvas uses — no canvas library, no per-frame JS.
 */
function EdgeLine({
  from,
  to,
}: {
  from: { x: number; y: number };
  to: { x: number; y: number };
}) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  return (
    <View
      pointerEvents="none"
      style={[
        styles.edge,
        {
          left: from.x,
          top: from.y,
          width: length,
          transform: [{ translateX: -3.5 }, { rotate: `${angle}deg` }],
        },
      ]}
    />
  );
}

/** The ring's own geometry — the fold already answered its radius in units. */
function ringStyle(model: ConstellationModel) {
  const ring = model.ring;
  return {
    left: ring.cx - ring.radius,
    top: ring.cy - ring.radius,
    width: ring.radius * 2,
    height: ring.radius * 2,
    borderRadius: ring.radius,
    borderColor: Palette.borderSubtle,
  };
}

const styles = StyleSheet.create({
  canvas: {
    borderRadius: Radius.md,
    borderColor: Palette.border,
    borderWidth: 1,
    overflow: 'hidden',
    backgroundColor: Palette.backgroundInset,
  },
  canvasEmpty: {
    minHeight: 240,
  },
  ring: {
    position: 'absolute',
    borderWidth: 1,
    opacity: 0.4,
  },
  edge: {
    position: 'absolute',
    height: 1,
    backgroundColor: Palette.borderStrong,
    opacity: 0.5,
  },
  node: {
    position: 'absolute',
    alignItems: 'center',
    padding: Spacing.one,
    borderWidth: 1,
    borderRadius: Radius.sm,
    backgroundColor: Palette.backgroundElevated,
  },
  botSeat: {
    position: 'absolute',
    alignItems: 'center',
    padding: Spacing.one,
    borderWidth: 1,
    borderRadius: Radius.sm,
    backgroundColor: Palette.backgroundElevated,
    zIndex: 2,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginBottom: Spacing.half,
  },
  nodeName: {
    textAlign: 'center',
  },
  nodeStatus: {
    fontSize: 11,
    textAlign: 'center',
  },
});

/**
 * The screen's prose states — the empty fleet and the legend line under the
 * map — live in this module so the drawer owns everything the map paints
 * beside its ring.
 */
export function ConstellationEmptyState({ children }: { children: string }) {
  return (
    <Card variant="surface" padding={Spacing.three}>
      <UiText variant="body" color="secondary">
        {children}
      </UiText>
    </Card>
  );
}
