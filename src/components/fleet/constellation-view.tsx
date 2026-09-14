import { StyleSheet, View, useWindowDimensions } from 'react-native';

import { Badge, EmptyState, GlassSurface, PressableScale, Text } from '@/components/ui';
import { Icon } from '@/components/ui/Icon';
import { Radius, Spacing } from '@/constants/tokens';
import { useNow } from '@/hooks/use-now';
import { useTokens } from '@/hooks/use-tokens';
import {
  constellationEmptyCopy,
  constellationLayout,
  constellationNodeAccessibilityLabel,
  constellationSummaryCopy,
  relativeLastSeenCopy,
  type ConstellationModel,
  type ConstellationNode,
} from '@/lib/fleet/constellation-model';

import { ConstellationCanvas } from './constellation-canvas';

export type ConstellationViewProps = {
  /** The graph `constellationModel` emitted — this view never rebuilds it. */
  model: ConstellationModel;
  /** An optional square override; otherwise the map fills the screen width. */
  size?: number;
  /** A node tap: the route decides (Bot Chat, or connect a gateway). */
  onPressNode?: (node: ConstellationNode) => void;
  /** An approvals badge tap: the route opens Activity. */
  onPressApproval?: (node: ConstellationNode) => void;
};

const NODE_BOX_WIDTH = 148;
const LABEL_OFFSET = 34;

/**
 * D2's lens, rebuilt: the map fills the screen — no fixed 320 pt square, no
 * fleet that loses a profile off the edge. The canvas paints the night sky,
 * and this layer makes each star tappable with its label, its date and its
 * badges inside the same envelope as the canvas, so the layout never clips.
 *
 * Under the map, the HUD's one line answers "why is this here": what is live,
 * how many Bots, what is running, what waits on you — straight from the
 * model's own summary. Read-only by design: no editing, no fetches, no
 * polling of its own.
 */
export function ConstellationView({
  model,
  size,
  onPressNode,
  onPressApproval,
}: ConstellationViewProps) {
  // One reading of the clock for every "last seen" line: not a ticking
  // display, so it never re-renders on its own.
  const now = useNow(60_000, false);
  const tokens = useTokens();
  const { width: screenWidth } = useWindowDimensions();

  if (model.empty) {
    const empty = constellationEmptyCopy();
    return (
      <EmptyState
        icon={{ ios: 'network', android: 'hub', web: 'hub' }}
        title={empty.title}
        description={empty.description}
      />
    );
  }

  // The whole-screen width minus the route's page padding, capped so a tablet
  // does not stretch the sky absurdly: the map is the hero, not a poster.
  const box = size ?? Math.min(screenWidth - 2 * Spacing.four, 520);
  const layout = constellationLayout(model, box);
  const summaryCopy = constellationSummaryCopy(model.summary);

  return (
    <View style={styles.root}>
      <GlassSurface variant="hero" radius={Radius.xxl} style={styles.stage}>
        <View style={[styles.mapWrap, { width: box, height: box }]}>
          <ConstellationCanvas model={model} size={box} />
          {layout.nodes.map((node) => (
            <PressableScale
              key={node.id}
              onPress={() => onPressNode?.(node)}
              accessibilityRole="button"
              accessibilityLabel={constellationNodeAccessibilityLabel(node)}
              style={[
                styles.node,
                {
                  left: node.x - NODE_BOX_WIDTH / 2,
                  top: node.y - LABEL_OFFSET,
                  width: NODE_BOX_WIDTH,
                },
              ]}>
              <Text variant="micro" numberOfLines={1} color={node.live ? 'accentWarm' : 'tertiary'}>
                {node.label}
              </Text>
              {node.lastSeenAt !== undefined && !node.live ? (
                <Text variant="micro" color="tertiary" numberOfLines={1}>
                  {relativeLastSeenCopy(node.lastSeenAt, now)}
                </Text>
              ) : null}
              {node.badges.length > 0 ? (
                <View style={styles.badges}>
                  {node.badges.map((badge) =>
                    badge.tone === 'danger' && onPressApproval ? (
                      <PressableScale
                        key={badge.label}
                        onPress={() => onPressApproval(node)}
                        accessibilityRole="button"
                        accessibilityLabel={`${node.label}, ${badge.label}`}>
                        <Badge label={badge.label} tone={badge.tone} dot={false} />
                      </PressableScale>
                    ) : (
                      <Badge key={badge.label} label={badge.label} tone={badge.tone} dot={false} />
                    ),
                  )}
                </View>
              ) : null}
            </PressableScale>
          ))}
        </View>
        {/* The HUD: one honest line from the model's own summary. */}
        <View style={[styles.hud, { borderTopColor: tokens.glassBorder }]}>
          <Icon
            name={{ ios: 'circle.grid.2x2.fill', android: 'hub', web: 'hub' }}
            size={13}
            color={model.summary.live ? 'statusConnected' : 'tertiary'}
          />
          <Text variant="caption" color={model.summary.live ? 'secondary' : 'tertiary'} numberOfLines={1}>
            {summaryCopy}
          </Text>
          {model.summary.approvals > 0 ? (
            <Badge label={`${model.summary.approvals}`} tone="danger" dot={false} />
          ) : null}
        </View>
      </GlassSurface>
      <Text variant="micro" color="tertiary" style={styles.legend}>
        Tap a star to open it. A saved gateway is dimmed and dated; only the connected one shares
        its Bots.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    gap: Spacing.three,
  },
  stage: {
    alignSelf: 'center',
  },
  mapWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  node: {
    position: 'absolute',
    alignItems: 'center',
    gap: Spacing.half,
  },
  badges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: Spacing.half,
  },
  hud: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  legend: {
    textAlign: 'center',
    maxWidth: 320,
    paddingHorizontal: Spacing.three,
  },
});
