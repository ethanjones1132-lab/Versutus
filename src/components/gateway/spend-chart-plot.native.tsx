import { Component, type ErrorInfo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Canvas, Rect } from '@shopify/react-native-skia';

import { useTokens } from '@/hooks/use-tokens';
import { SPEND_CHART_FRAME, spendChartBars } from '@/lib/gateway/spend-chart';

import { SpendChartPlotFallback, type SpendChartPlotProps } from './spend-chart-plot-fallback';

/**
 * The AmbientCanvas boundary, for the same reason: a Skia mount can throw
 * where there is no GPU surface, and a chart is not worth taking the screen
 * down for. The plain plot draws the same bars from the same geometry.
 */
class SkiaPlotBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
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
 * P5's 7-day chart on native, in Skia.
 *
 * The bars are `spendChartBars` in `SPEND_CHART_FRAME` — the same helper and
 * the same box the plain plot uses — so this file only paints what the week
 * fold already decided. A bar of zero height paints nothing, which is what an
 * empty day is: no minimum bar that could read as spend.
 */
export function SpendChartPlot(props: SpendChartPlotProps) {
  return (
    <SkiaPlotBoundary fallback={<SpendChartPlotFallback {...props} />}>
      <SkiaPlot {...props} />
    </SkiaPlotBoundary>
  );
}

function SkiaPlot({ buckets }: SpendChartPlotProps) {
  const tokens = useTokens();
  const bars = spendChartBars(buckets, SPEND_CHART_FRAME);

  return (
    <View style={[styles.plot, { borderBottomColor: tokens.border }]}>
      <Canvas style={styles.canvas}>
        {bars.map((bar) => (
          <Rect
            key={bar.startMs}
            x={bar.x}
            y={bar.y}
            width={bar.width}
            height={bar.height}
            color={tokens.accentWarm}
          />
        ))}
      </Canvas>
    </View>
  );
}

const styles = StyleSheet.create({
  plot: {
    width: SPEND_CHART_FRAME.width,
    height: SPEND_CHART_FRAME.height,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  canvas: {
    width: SPEND_CHART_FRAME.width,
    height: SPEND_CHART_FRAME.height,
  },
});
