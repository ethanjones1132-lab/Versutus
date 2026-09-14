import { StyleSheet, View } from 'react-native';
import Svg, { Circle, G, Line } from 'react-native-svg';

import { useTokens } from '@/hooks/use-tokens';
import {
  CONSTELLATION_NODE_RADIUS,
  constellationLayout,
  type ConstellationModel,
} from '@/lib/fleet/constellation-model';

export type ConstellationCanvasProps = {
  /** The pure model `constellationModel` emitted; never re-derived here. */
  model: ConstellationModel;
  /** The box the model is scaled into, in points. */
  size: number;
  /** The box's height; defaults to `size` so the map stays square. */
  height?: number;
};

/**
 * D2's map in plain SVG: what web bundles, and what a native Skia mount falls
 * back to when it throws. Both painters call `constellationLayout` on the same
 * model in the same box, so the picture is identical on either path and
 * neither works out the graph a second time.
 *
 * A live node is a bright star with a halo ring; a saved-but-down gateway is a
 * dim hollow ring — the two truth classes never blur. A running Bot glows
 * through a soft halo and an approval is a red ember: the same story Skia
 * renders natively, at the fidelity plain SVG reaches.
 */
export function ConstellationCanvasFallback({ model, size, height }: ConstellationCanvasProps) {
  const tokens = useTokens();
  const boxHeight = height ?? size;
  const layout = constellationLayout(model, size, boxHeight);

  return (
    <View style={[styles.canvas, { width: size, height: boxHeight }]}>
      <Svg width={size} height={boxHeight}>
        {layout.edges.map((edge) => (
          <G key={edge.id}>
            <Line
              x1={edge.x1}
              y1={edge.y1}
              x2={edge.x2}
              y2={edge.y2}
              stroke={tokens.accentWarm as string}
              strokeWidth={2.5}
              opacity={0.08}
            />
            <Line
              x1={edge.x1}
              y1={edge.y1}
              x2={edge.x2}
              y2={edge.y2}
              stroke={tokens.accentWarm as string}
              strokeWidth={StyleSheet.hairlineWidth}
              opacity={0.5}
            />
          </G>
        ))}
        {/* Live halos first, so stars paint over their own glow. */}
        {layout.nodes
          .filter((node) => node.live)
          .map((node) => (
            <Circle
              key={`halo:${node.id}`}
              cx={node.x}
              cy={node.y}
              r={node.kind === 'gateway' ? 26 : 18}
              fill={(node.kind === 'gateway' ? tokens.accentWarmMuted : tokens.accentMuted) as string}
              opacity={0.32}
            />
          ))}
        {layout.nodes.map((node) => {
          const isGateway = node.kind === 'gateway';
          const radius = isGateway ? CONSTELLATION_NODE_RADIUS + 2 : CONSTELLATION_NODE_RADIUS - 3;
          const cx = node.x;
          const cy = node.y;
          if (node.live) {
            return (
              <G key={node.id}>
                <Circle
                  cx={cx}
                  cy={cy}
                  r={radius * 2.2}
                  fill={(isGateway ? tokens.accentWarm : tokens.accent) as string}
                  opacity={0.16}
                />
                <Circle cx={cx} cy={cy} r={radius} fill={tokens.accentWarm as string} />
                <Circle
                  cx={cx}
                  cy={cy}
                  r={radius + 5}
                  fill="none"
                  stroke={(isGateway ? tokens.statusConnectedMuted : tokens.accentMuted) as string}
                  strokeWidth={1.5}
                />
                {node.badges.some((badge) => badge.tone === 'accent') ? (
                  <Circle
                    cx={cx}
                    cy={cy}
                    r={radius + 10}
                    fill={(tokens.accentWarm ?? tokens.accent) as string}
                    opacity={0.2}
                  />
                ) : null}
              </G>
            );
          }
          return (
            <Circle
              key={node.id}
              cx={cx}
              cy={cy}
              r={radius}
              fill="none"
              stroke={tokens.textTertiary as string}
              strokeWidth={1.5}
              opacity={0.5}
            />
          );
        })}
        {layout.nodes
          .filter((node) => node.badges.some((badge) => badge.tone === 'danger'))
          .map((node) => (
            <Circle
              key={`app:${node.id}`}
              cx={node.x + CONSTELLATION_NODE_RADIUS + 3}
              cy={node.y - CONSTELLATION_NODE_RADIUS - 3}
              r={3.5}
              fill={tokens.statusDisconnected as string}
            />
          ))}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
