import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useRouter } from 'expo-router';

import { Screen, Text } from '@/components/ui';
import {
  ConstellationCanvas,
  ConstellationEmptyState,
} from '@/components/fleet/fleet-constellation';
import { FleetConnectSheet } from '@/components/fleet/fleet-connect-sheet';
import { Spacing } from '@/constants/tokens';
import { humanizeGatewayError } from '@/lib/gateway/error-humanizer';
import { constellationConnectOffer } from '@/lib/fleet/connect-offer';
import { useGateway } from '@/context/gateway-provider';
import { useGatewayReachability } from '@/hooks/use-gateway-reachability';
import type { PublicBot } from '@/lib/gateway/bots';
import type { GatewayProfile } from '@/lib/gateway/types';

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
 *
 * Tapping a saved node opens the connect sheet — the action the two-truth map
 * exists to drive. The connect rides the provider's own `connectGateway`
 * promise (the same one gateway settings uses), never a forked handshake of
 * the map's own; a mid-handshake node shows its honest label and refuses a
 * re-tap; a failed `connectGateway` surfaces `humanizeGatewayError`'s copy at
 * the sheet, not a toast that vanishes.
 *
 * The Bot cluster beneath the live gateway draws the roster the provider
 * already holds: it is loaded through the provider's own `listBots` once the
 * gateway is connected (a saved cluster is an absent roster, never a cached
 * guess), and a tap on a seat is the provider's own `openBot` then `/chat` —
 * the same landed-open seam the deep-link router rides.
 */
export default function FleetScreen() {
  const { gateways, activeGateway, status, connectGateway, listBots, openBot } =
    useGateway();
  const router = useRouter();
  const reachability = useGatewayReachability({ gateways, activeGateway, status });
  // The `now` the fold dates with is captured on mount, the way the spend
  // screen captures its bucket boundary — re-stamping every render would make
  // dates drift while nothing underneath them moved.
  const [now] = useState(() => Date.now());
  const [canvas, setCanvas] = useState<{ width: number | null; height: number | null }>({
    width: null,
    height: null,
  });
  // The sheet's open node, and the connect attempt's own state: the gateway
  // the promise is in flight for (the re-tap refusal) and the humanized cause
  // the last failed attempt on the node the sheet is open on surfaced.
  const [sheetProfile, setSheetProfile] = useState<GatewayProfile | null>(null);
  const [handshakeTargetId, setHandshakeTargetId] = useState<string | null>(null);
  const [failureCauses, setFailureCauses] = useState<Record<string, string>>({});
  // The live gateway's roster: the Bot cluster's seats. Loaded only on the
  // connected edge, from the provider's own `listBots` — never cached, never
  // guessed for a saved gateway.
  const [roster, setRoster] = useState<PublicBot[]>([]);
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

  const handleGatewayPress = useCallback(
    (profile: GatewayProfile) => {
      // A saved node only: the drawer answers the press, the fold's classes
      // already named this node saved, so nothing to re-derive here.
      if (status === 'connected' && activeGateway?.id === profile.id) return;
      setFailureCauses((previous) => {
        if (!previous[profile.id]) return previous;
        const next = { ...previous };
        delete next[profile.id];
        return next;
      });
      setSheetProfile(profile);
    },
    [activeGateway?.id, status],
  );

  const handleConnect = useCallback(async () => {
    const profile = sheetProfile;
    if (!profile) return;
    setHandshakeTargetId(profile.id);
    try {
      await connectGateway(profile);
    } catch (error) {
      // The sheet owns the failure: humanizeGatewayError's copy, held on the
      // profile the attempt named, so the sheet reads it on its next render.
      const cause = humanizeGatewayError(error).cause;
      setFailureCauses((previous) => ({ ...previous, [profile.id]: cause }));
      return;
    } finally {
      setHandshakeTargetId(null);
    }
  }, [connectGateway, sheetProfile]);

  const activeGatewayId = activeGateway?.id ?? null;
  const connected = status === 'connected' && activeGatewayId !== null;
  // The roster is the connected gateway's own: a change of gateway or a drop
  // of the connection empties the cluster before a stale roster can draw.
  useEffect(() => {
    if (!connected || !listBots || !activeGatewayId) return;
    let cancelled = false;
    listBots()
      .then((bots) => {
        if (!cancelled) setRoster(bots);
      })
      .catch(() => {
        // The roster is the cluster's garnish, not a fetch the screen
        // depends on — a refused list answers an empty cluster, honestly.
        if (!cancelled) setRoster([]);
      });
    return () => {
      cancelled = true;
      // A drop of the connected edge empties the cluster here, on the path
      // the state change itself names, never as a bare mid-render reset.
      setRoster([]);
    };
  }, [connected, activeGatewayId, listBots]);

  const navigateToChat = useCallback(() => {
    router.navigate('/chat');
  }, [router]);
  // The sheet's decision is the fold's own answer, never a re-derivation.
  const sheetOffer = sheetProfile
    ? constellationConnectOffer({
        truth:
          connected && activeGatewayId === sheetProfile.id ? 'live' : 'saved',
        gatewayId: sheetProfile.id,
        status,
        handshakeTargetId,
        failureCause: failureCauses[sheetProfile.id] ?? null,
      })
    : null;

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
            activeGatewayId={activeGatewayId}
            status={status}
            roster={roster}
            connected={connected}
            openBot={openBot}
            navigateToChat={navigateToChat}
            onGatewayPress={handleGatewayPress}
          />
        </View>

        {gateways.length === 0 ? (
          <ConstellationEmptyState>
            No gateway saved yet. Connect one from Home and it will sit on this ring.
          </ConstellationEmptyState>
        ) : null}
      </View>

      {sheetProfile && sheetOffer ? (
        <FleetConnectSheet
          gatewayName={sheetProfile.name}
          offer={sheetOffer}
          onConnect={() => void handleConnect()}
          onClose={() => setSheetProfile(null)}
        />
      ) : null}
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
