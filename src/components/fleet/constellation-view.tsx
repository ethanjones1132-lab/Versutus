import { StyleSheet, View } from 'react-native';

import { Badge, EmptyState, PressableScale, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useNow } from '@/hooks/use-now';
import {
  constellationEmptyCopy,
  constellationLayout,
  constellationNodeAccessibilityLabel,
  relativeLastSeenCopy,
  type ConstellationModel,
  type ConstellationNode,
} from '@/lib/fleet/constellation-model';

import { ConstellationCanvas } from './constellation-canvas';

export type ConstellationViewProps = {
  /** The graph `constellationModel` emitted — this view never rebuilds it. */
  model: ConstellationModel;
  /** The square the map is drawn in, in points. */
  size?: number;
  /** A node tap: the route decides (Bot Chat, or connect a gateway). */
  onPressNode?: (node: ConstellationNode) => void;
  /** An approvals badge tap: the route opens Activity. */
  onPressApproval?: (node: ConstellationNode) => void;
};

const DEFAULT_SIZE = 320;
const NODE_BOX_WIDTH = 136;
const LABEL_OFFSET = 30;

/**
 * D2's lens: the canvas paints the graph, and this layer makes each node
 * tappable and readable. Labels and dates come from the pure model's own
 * honesty helpers, so a saved gateway is always dated and a screen reader
 * never hears a down gateway called live.
 *
 * Read-only by design: no editing, no fetches, no polling of its own.
 */
export function ConstellationView({
  model,
  size = DEFAULT_SIZE,
  onPressNode,
  onPressApproval,
}: ConstellationViewProps) {
  // One reading of the clock for every "last seen" line: not a ticking
  // display, so it never re-renders on its own.
  const now = useNow(60_000, false);

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

  const layout = constellationLayout(model, size);

  return (
    <View style={styles.root}>
      <View style={[styles.stage, { width: size, height: size }]}>
        <ConstellationCanvas model={model} size={size} />
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
            <Text variant="micro" numberOfLines={1} color={node.live ? 'primary' : 'tertiary'}>
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
      <Text variant="micro" color="tertiary" style={styles.legend}>
        Live gateways and Bots are bright; a saved gateway is dimmed and dated.
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
    borderRadius: Radius.xl,
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
  legend: {
    textAlign: 'center',
    maxWidth: 300,
    paddingHorizontal: Spacing.three,
  },
});
