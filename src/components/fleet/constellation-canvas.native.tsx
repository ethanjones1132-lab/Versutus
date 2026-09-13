import { Component, type ErrorInfo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Canvas, Circle, Line } from '@shopify/react-native-skia';

import { useTokens } from '@/hooks/use-tokens';
import {
  CONSTELLATION_NODE_RADIUS,
  constellationLayout,
} from '@/lib/fleet/constellation-model';

import {
  ConstellationCanvasFallback,
  type ConstellationCanvasProps,
} from './constellation-canvas-fallback';

/**
 * The same boundary `SpendChartPlot` and `AmbientCanvas` keep: a Skia mount can
 * throw where there is no GPU surface, and a fleet map is not worth taking the
 * screen down for. The plain SVG canvas draws the same layout.
 */
class SkiaConstellationBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    this.setState({ failed: true });
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * D2's map on native, in Skia. The edges and node rings are `constellationLayout`
 * in the shared square — this file only paints what the pure model already
 * decided, so a down gateway is dimmed here exactly as it is in the fallback.
 */
export function ConstellationCanvas(props: ConstellationCanvasProps) {
  return (
    <SkiaConstellationBoundary fallback={<ConstellationCanvasFallback {...props} />}>
      <SkiaConstellation {...props} />
    </SkiaConstellationBoundary>
  );
}

function SkiaConstellation({ model, size }: ConstellationCanvasProps) {
  const tokens = useTokens();
  const layout = constellationLayout(model, size);

  return (
    <View style={[styles.canvas, { width: size, height: size }]}>
      <Canvas style={{ width: size, height: size }}>
        {layout.edges.map((edge) => (
          <Line
            key={edge.id}
            p1={{ x: edge.x1, y: edge.y1 }}
            p2={{ x: edge.x2, y: edge.y2 }}
            color={tokens.border}
            strokeWidth={StyleSheet.hairlineWidth}
          />
        ))}
        {layout.nodes.map((node) => (
          <Circle
            key={node.id}
            cx={node.x}
            cy={node.y}
            r={node.kind === 'gateway' ? CONSTELLATION_NODE_RADIUS : CONSTELLATION_NODE_RADIUS - 3}
            color={node.live ? tokens.accentWarm : tokens.textTertiary}
            opacity={node.live ? 1 : 0.5}
          />
        ))}
      </Canvas>
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
