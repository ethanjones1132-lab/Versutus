import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { ConstellationView } from '@/components/fleet/constellation-view';
import { Screen, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useGatewayReachability } from '@/hooks/use-gateway-reachability';
import type { PublicBot } from '@/lib/gateway/bots';
import { fleetConstellationInput } from '@/lib/fleet/constellation-input';
import { constellationModel, type ConstellationNode } from '@/lib/fleet/constellation-model';

/** One stable empty roster, so a disconnected render keeps its memo. */
const NO_ROSTER: PublicBot[] = [];

/**
 * D2's destination: the fleet as a lens. It reads only what the app already
 * holds — the saved profiles, the connected gateway's live state, the probe
 * wave the dashboard mounts, and the existing `listBots` roster read — and
 * folds them through the pure model. It adds no protocol, no poll and no
 * editing; a tap drives the shipped destination instead (a Bot's chat, a
 * gateway's connect, Activity for an approval).
 *
 * The two truth classes are the point: one gateway is live, and every saved
 * gateway is dimmed and dated. The view enforces that; this screen only
 * supplies the truth.
 */
export default function FleetScreen() {
  const router = useRouter();
  const {
    gateways,
    activeGateway,
    status,
    activityRuns,
    pendingRunApproval,
    listBots,
    openBot,
    requestSurface,
    connectGateway,
  } = useGateway();
  const reachability = useGatewayReachability({ gateways, activeGateway, status });
  const [roster, setRoster] = useState<PublicBot[]>([]);

  // The connected gateway's roster, through the read the Chat roster already
  // uses. One read on connect, never a poll; a refusal leaves the cluster
  // empty rather than inventing Bots. A stale roster from a previous
  // connection is masked below rather than cleared in the effect body.
  useEffect(() => {
    if (status !== 'connected') return undefined;
    let cancelled = false;
    void listBots()
      .then((bots) => {
        if (!cancelled) setRoster(bots);
      })
      .catch(() => {
        if (!cancelled) setRoster([]);
      });
    return () => {
      cancelled = true;
    };
  }, [status, listBots]);

  const connectedRoster = status === 'connected' ? roster : NO_ROSTER;

  const model = useMemo(
    () =>
      constellationModel(
        fleetConstellationInput({
          gateways,
          connectedGatewayId: status === 'connected' ? activeGateway?.id : undefined,
          reachability,
          roster: connectedRoster.map((bot) => ({ id: bot.id, displayName: bot.displayName })),
          activityRuns,
          pendingRunApproval,
        }),
      ),
    [
      gateways,
      status,
      activeGateway?.id,
      reachability,
      connectedRoster,
      activityRuns,
      pendingRunApproval,
    ],
  );

  const handlePressNode = (node: ConstellationNode) => {
    if (node.kind === 'bot') {
      const botId = node.botId;
      if (!botId) return;
      void openBot(botId)
        .then((opened) => {
          if (!opened) {
            requestSurface({ kind: 'roster' });
            return;
          }
          requestSurface({ kind: 'bot', botId });
          router.navigate('/chat');
        })
        .catch(() => requestSurface({ kind: 'roster' }));
      return;
    }
    const gateway = gateways.find((candidate) => candidate.id === node.gatewayId);
    if (gateway && !node.live) void connectGateway(gateway);
  };

  const handlePressApproval = () => {
    router.push('/activity');
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.heading}>
          <Text variant="title">Fleet</Text>
          <Text variant="caption" color="secondary">
            The gateways this device knows, and the Bots on the one it is connected to. A saved
            gateway is dimmed and dated; only the connected one is live.
          </Text>
        </View>
        <ConstellationView
          model={model}
          onPressNode={handlePressNode}
          onPressApproval={handlePressApproval}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: Spacing.four,
    gap: Spacing.four,
  },
  heading: {
    gap: Spacing.one,
  },
});
