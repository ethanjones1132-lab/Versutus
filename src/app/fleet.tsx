import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Screen, Text } from '@/components/ui';
import {
  ConstellationCanvas,
  ConstellationEmptyState,
} from '@/components/fleet/fleet-constellation';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useGatewayReachability } from '@/hooks/use-gateway-reachability';

/**
 * D2's destination: the fleet on one map.
 *
 * The screen hands the provider facts the fold consumes — the saved gateway
 * roster, the active gateway's id, the connection status, the probe wave's
 * reachability records — to `foldConstellation` through the drawer and paints
 * only what the fold answers. It fetches nothing the wave hook and the
 * provider do not already hold, and it keeps no roster of its own: the
 * Bot-cluster and routine-arc layers are their own slices.
 *
 * The stage measures itself and hands the drawer real units; before the first
 * layout the drawer holds its ring back rather than scattering off-canvas.
 */
export default function FleetScreen() {
  const { gateways, activeGateway, status } = useGateway();
  const reachability = useGatewayReachability({ gateways, activeGateway, status });
  // The `now` the fold dates with is captured on mount, the way the spend
  // screen captures its bucket boundary — re-stamping every render would make
  // dates drift while nothing underneath them moved.
  const [now] = useState(() => Date.now());
  const [canvas, setCanvas] = useState<{ width: number | null; height: number | null }>({
    width: null,
    height: null,
  });
  const onStageLayout = useCallback(
    (width: number, height: number) => {
      setCanvas((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    },
    [],
  );

  return (
    <Screen>
      <View style={styles.body}>
        <Text variant="title">Fleet</Text>
        <Text variant="caption" color="secondary">
          Every saved gateway, on one ring. The connected gateway is live; the rest are saved and
          dated — never guessed green.
        </Text>

        <View
          style={styles.stage}
          testID="fleet-stage"
          onLayout={(event) => onStageLayout(event.nativeEvent.layout.width, event.nativeEvent.layout.height)}
        >
          <ConstellationCanvas
            width={canvas.width}
            height={canvas.height}
            now={now}
            profiles={gateways}
            reachability={reachability}
            activeGatewayId={activeGateway?.id ?? null}
            status={status}
          />
        </View>

        {gateways.length === 0 ? (
          <ConstellationEmptyState>
            No gateway saved yet. Connect one from Home and it will sit on this ring.
          </ConstellationEmptyState>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    padding: Spacing.four,
    gap: Spacing.three,
  },
  stage: {
    flex: 1,
    minHeight: 280,
  },
});
