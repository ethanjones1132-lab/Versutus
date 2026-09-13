import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';

import { useTokens } from '@/hooks/use-tokens';
import {
  CONSTELLATION_NODE_RADIUS,
  constellationLayout,
  type ConstellationModel,
} from '@/lib/fleet/constellation-model';

export type ConstellationCanvasProps = {
  /** The pure model `constellationModel` emitted; never re-derived here. */
  model: ConstellationModel;
  /** The square the model is scaled into, in points. */
  size: number;
};

/**
 * D2's map in plain SVG: what web bundles, and what a native Skia mount falls
 * back to when it throws. Both painters call `constellationLayout` on the same
 * model in the same square, so the picture is identical on either path and
 * neither works out the graph a second time.
 *
 * A live node is bright with a status ring; a saved-but-down gateway is dimmed
 * and dashed of ring — the two truth classes never blur.
 */
export function ConstellationCanvasFallback({ model, size }: ConstellationCanvasProps) {
  const tokens = useTokens();
  const layout = constellationLayout(model, size);

  return (
    <View style={[styles.canvas, { width: size, height: size }]}>
      <Svg width={size} height={size}>
        {layout.edges.map((edge) => (
          <Line
            key={edge.id}
            x1={edge.x1}
            y1={edge.y1}
            x2={edge.x2}
            y2={edge.y2}
            stroke={tokens.border}
            strokeWidth={StyleSheet.hairlineWidth}
          />
        ))}
        {layout.nodes.map((node) => (
          <Circle
            key={node.id}
            cx={node.x}
            cy={node.y}
            r={node.kind === 'gateway' ? CONSTELLATION_NODE_RADIUS : CONSTELLATION_NODE_RADIUS - 3}
            fill={node.live ? tokens.accentWarm : tokens.textTertiary}
            opacity={node.live ? 1 : 0.5}
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
