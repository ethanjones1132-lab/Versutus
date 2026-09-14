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
 */

import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Card, PressableScale, Text as UiText } from '@/components/ui';
import {
  foldConstellation,
  type ConstellationModel,
} from '@/lib/fleet/constellation-model';
import { constellationStatusCopy, lastSeenCopy } from '@/lib/fleet/last-seen-label';
import { Palette, Radius, Spacing } from '@/constants/tokens';
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

export const ConstellationCanvas = memo(function ConstellationCanvas({
  width,
  height,
  now,
  profiles,
  reachability,
  activeGatewayId,
  status,
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
  /**
   * The connect affordance the two-truth map exists to drive: tapping a node
   * hands its profile up; the screen decides what the fold's two classes
   * mean for the tap — the live node is not a button to itself.
   */
  onGatewayPress?: (profile: GatewayProfile) => void;
}) {
  // A canvas that has not answered layout yet answers an empty ring: the map
  // appears on the first measured frame instead of scattering off-canvas.
  if (width === null || height === null) {
    return <View style={[styles.canvas, styles.canvasEmpty]} />;
  }
  const model = foldConstellation({
    profiles,
    reachability,
    activeGatewayId,
    status,
    width,
    height,
    now,
  });

  return (
    <View style={[styles.canvas, { height: Math.max(240, width / CANVAS_ASPECT) }]}>
      {model.gateways.length > 0 ? (
        <View style={[styles.ring, ringStyle(model)]} />
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
    </View>
  );
});

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
  node: {
    position: 'absolute',
    alignItems: 'center',
    padding: Spacing.one,
    borderWidth: 1,
    borderRadius: Radius.sm,
    backgroundColor: Palette.backgroundElevated,
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
