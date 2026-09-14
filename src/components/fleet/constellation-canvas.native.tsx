import { Component, type ErrorInfo, type ReactNode, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  BlurMask,
  Canvas,
  Circle,
  Group,
  Line,
  RadialGradient,
  vec,
} from '@shopify/react-native-skia';
import {
  cancelAnimation,
  Easing,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

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

export function ConstellationCanvas(props: ConstellationCanvasProps) {
  return (
    <SkiaConstellationBoundary fallback={<ConstellationCanvasFallback {...props} />}>
      <SkiaConstellation {...props} />
    </SkiaConstellationBoundary>
  );
}

const PULSE = Easing.inOut(Easing.sin);

function SkiaConstellation({ model, size: width, height }: ConstellationCanvasProps) {
  const tokens = useTokens();
  const layout = constellationLayout(model, width, height);
  const pulse = useSharedValue(0);

  // One slow breath for every running star: the fleet visibly at work, at
  // glance speed — never a strobe, never a battery-burner.
  useEffect(() => {
    pulse.value = withRepeat(withTiming(1, { duration: 2600, easing: PULSE }), -1, true);
    return () => cancelAnimation(pulse);
  }, [pulse]);

  // Edges and stars shift with each breath; both reads stay on the UI thread.
  const edgeOpacity = useDerivedValue(() => 0.5 + 0.5 * pulse.value);
  const runningGlow = useDerivedValue(() => 0.55 + 0.45 * pulse.value);

  return (
    <View style={[styles.canvas, { width, height }]}>
      <Canvas style={{ width, height }}>
        {/* The night sky: one soft halo behind the graph on live icons, so the
            connected world reads as lit while saved ones stay in shadow. */}
        {layout.nodes
          .filter((node) => node.live)
          .map((node) => (
            <Circle
              key={`halo:${node.id}`}
              cx={node.x}
              cy={node.y}
              r={node.kind === 'gateway' ? 46 : 30}
              opacity={0.14}
            >
              <RadialGradient
                c={vec(node.x, node.y)}
                r={node.kind === 'gateway' ? 46 : 30}
                colors={[
                  node.kind === 'gateway' ? tokens.accentWarmMuted : tokens.accentMuted,
                  'transparent',
                ]}
              />
            </Circle>
          ))}

        {/* Host edges: fine gold threads, drifting brighter with the breath. */}
        <Group opacity={edgeOpacity}>
          {layout.edges.map((edge) => (
            <Group key={`edgeglow:${edge.id}`}>
              <Line
                p1={{ x: edge.x1, y: edge.y1 }}
                p2={{ x: edge.x2, y: edge.y2 }}
                color={tokens.accentWarm}
                strokeWidth={2.5}
                opacity={0.1}
              />
              <Line
                p1={{ x: edge.x1, y: edge.y1 }}
                p2={{ x: edge.x2, y: edge.y2 }}
                color={tokens.accentWarm}
                strokeWidth={StyleSheet.hairlineWidth}
                opacity={0.5}
              />
            </Group>
          ))}
        </Group>

        {/* Stars: gateway nodes are the bright class; saved gateways are
            dimmed hollow rings, the truth classes never blur. */}
        {layout.nodes.map((node) => {
          const isGateway = node.kind === 'gateway';
          const radius = isGateway ? CONSTELLATION_NODE_RADIUS + 2 : CONSTELLATION_NODE_RADIUS - 3;
          if (node.live) {
            return (
              <Group key={node.id}>
                <Circle cx={node.x} cy={node.y} r={radius * 2.4} opacity={0.18}>
                  <BlurMask style="normal" blur={radius} respectCTM />
                </Circle>
                <Circle cx={node.x} cy={node.y} r={radius} color={tokens.accentWarm} />
                <Circle
                  cx={node.x}
                  cy={node.y}
                  r={radius + 5}
                  color={isGateway ? tokens.statusConnectedMuted : tokens.accentMuted}
                  style="stroke"
                  strokeWidth={1.5}
                />
              </Group>
            );
          }
          return (
            <Circle
              key={node.id}
              cx={node.x}
              cy={node.y}
              r={radius}
              color={tokens.textTertiary}
              opacity={0.5}
              style="stroke"
              strokeWidth={1.5}
            />
          );
        })}

        {/* A running star breathes — one extra glow per running Bot. */}
        {layout.nodes
          .filter((node) => node.live && node.badges.some((badge) => badge.tone === 'accent'))
          .map((node) => (
            <Group key={`run:${node.id}`} opacity={runningGlow}>
              <Circle cx={node.x} cy={node.y} r={CONSTELLATION_NODE_RADIUS + 6} opacity={0.35}>
                <BlurMask style="normal" blur={10} respectCTM />
              </Circle>
            </Group>
          ))}

        {/* An approval is a red ember on the Bot's shoulder. */}
        {layout.nodes
          .filter((node) => node.badges.some((badge) => badge.tone === 'danger'))
          .map((node) => (
            <Circle
              key={`app:${node.id}`}
              cx={node.x + CONSTELLATION_NODE_RADIUS + 3}
              cy={node.y - CONSTELLATION_NODE_RADIUS - 3}
              r={3.5}
              color={tokens.statusDisconnected}
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
