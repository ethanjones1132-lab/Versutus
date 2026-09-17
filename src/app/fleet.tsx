import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { ConstellationView } from '@/components/fleet/constellation-view';
import { FleetBotSheet } from '@/components/fleet/bot-sheet';
import { Screen, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useGatewayReachability } from '@/hooks/use-gateway-reachability';
import { botTap } from '@/lib/fleet/bot-tap';
import { botSheetView, type BotSheetView } from '@/lib/fleet/bot-sheet';
import { fleetConstellationInput } from '@/lib/fleet/constellation-input';
import { constellationModel, type ConstellationNode } from '@/lib/fleet/constellation-model';
import { gatewayHandshake } from '@/lib/fleet/gateway-handshake';
import { fleetRoutineRead } from '@/lib/fleet/routine-read';
import { failFleetRosterRead, fleetRosterRead, UNREPORTED_ROSTER } from '@/lib/fleet/roster-read';

/**
 * D2's destination, rebuilt: the fleet as a living star map. It reads only
 * what the app already holds — the saved profiles, the connected gateway's
 * live state, the probe wave the dashboard mounts, and the existing `listBots`
 * roster read — and folds them through the pure model. It adds no protocol,
 * no poll and no editing; a tap drives the shipped destination instead (a
 * Bot's chat, a gateway's connect, Activity for an approval). The map's HUD
 * answers "what should I care about" at a glance, from the model's summary.
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
    statusDetail,
    lastError,
    activityRuns,
    pendingRunApproval,
    capabilitySnapshot,
    listBots,
    openBot,
    requestSurface,
    connectGateway,
  } = useGateway();
  const reachability = useGatewayReachability({ gateways, activeGateway, status });
  const [rosterRead, setRosterRead] = useState(UNREPORTED_ROSTER);
  const rosterRequest = useMemo(
    () => ({ gatewayId: activeGateway?.id, status, listBots }),
    [activeGateway?.id, status, listBots],
  );

  // One existing read per connection, never a poll. The request identity
  // masks a prior connection before its effect runs; late results are ignored.
  useEffect(() => {
    const { gatewayId, status: readStatus, listBots } = rosterRequest;
    if (readStatus !== 'connected' || !gatewayId) return undefined;
    let cancelled = false;
    void listBots()
      .then((bots) => {
        if (!cancelled) setRosterRead({ gatewayId, bots, status: 'ready', request: rosterRequest });
      })
      .catch(() => {
        if (!cancelled) setRosterRead((read) => failFleetRosterRead(read, gatewayId, rosterRequest));
      });
    return () => {
      cancelled = true;
    };
  }, [rosterRequest]);

  const connectedRosterRead = useMemo(() => fleetRosterRead(rosterRead,
    status === 'connected' ? activeGateway?.id : undefined, rosterRequest),
  [rosterRead, status, activeGateway?.id, rosterRequest]);
  const connectedRoster = connectedRosterRead.bots;

  // The connected gateway's routine read, through the provider state the
  // widget write reads once per connected transition — one read, two
  // surfaces. A failed read keeps the last list there (its staleness is
  // sayable); a disconnected screen shows no arcs rather than a previous
  // gateway's routines.
  const { routineRead } = useGateway();
  const connectedRoutineRead = fleetRoutineRead(routineRead,
    status === 'connected' ? activeGateway?.id : undefined);
  const connectedRoutineJobs = connectedRoutineRead.jobs;

  // Where an unroutable or disconnected tap lands: the Chat tab's roster,
  // which carries the detail surface naming the verdict and the fix. The
  // route owns navigation; the sheet lives there (chat-screen's detailBot),
  // so this hands over the way every other cross-tab surface request does.
  const showRosterFallback = useCallback(() => {
    requestSurface({ kind: 'roster' });
    router.navigate('/chat');
  }, [requestSurface, router]);

  // One handshake line per saved gateway, computed by the same pure helper
  // that gates the tap — so what the map says and what the tap allows can
  // never disagree. A failure reason is only truthful for the gateway the
  // attempt belonged to; the reason for the attempt that belonged to another
  // is not this node's fact.
  const handshakeStatus = useMemo(() => {
    const lines: Record<string, string> = {};
    const connectionPhaseFailed = status === 'disconnected' || lastError !== null;
    for (const gateway of gateways) {
      const state = gatewayHandshake({
        gatewayName: gateway.name?.trim() || gateway.id,
        gatewayId: gateway.id,
        connectedGatewayId: status === 'connected' ? activeGateway?.id : undefined,
        activeGatewayId: activeGateway?.id,
        activeGatewayName: activeGateway?.name,
        status,
        failureReason:
          connectionPhaseFailed && activeGateway?.id === gateway.id
            ? (statusDetail || lastError)
            : null,
      });
      if (state.statusLine) lines[gateway.id] = state.statusLine;
    }
    return lines;
  }, [gateways, status, activeGateway?.id, activeGateway?.name, statusDetail, lastError]);

  const model = useMemo(
    () =>
      constellationModel(
        fleetConstellationInput({
          gateways,
          connectedGatewayId: status === 'connected' ? activeGateway?.id : undefined,
          reachability,
          capabilitySnapshot,
          rosterReadStatus: connectedRosterRead.status,
          roster: connectedRoster.map((bot) => ({ id: bot.id, displayName: bot.displayName })),
          routineReadStatus: connectedRoutineRead.status,
          cronJobs: connectedRoutineJobs.map((job) => ({
            id: job.id,
            name: job.name ?? undefined,
            title: job.title,
            paused: job.paused ?? undefined,
            running: job.running ?? undefined,
            lastStatus: job.lastStatus ?? undefined,
            lastError: job.lastError ?? undefined,
            lastDeliveryError: job.lastDeliveryError ?? undefined,
            cooldownReason: job.cooldownReason ?? undefined,
            failureStreak: job.failureStreak ?? undefined,
          })),
          activityRuns,
          pendingRunApproval,
        }),
      ),
    [
      gateways,
      status,
      activeGateway?.id,
      reachability,
      capabilitySnapshot,
      connectedRoster,
      connectedRosterRead.status,
      connectedRoutineJobs,
      connectedRoutineRead.status,
      activityRuns,
      pendingRunApproval,
    ],
  );

  const handlePressNode = (node: ConstellationNode) => {
    if (node.kind === 'bot') {
      const botId = node.botId;
      if (!botId) return;
      // The same pure decision the socket feed's chat tap defers to (`botTap`,
      // out of this class's own family of pure helpers): a routable Bot on the
      // live connection opens its thread; anything else opens the roster's
      // detail surface, which already shows why — never a silent no-op, never
      // an open the world has not reported it can carry.
      const bot = connectedRoster.find((candidate) => candidate.id === botId);
      const open = botTap(
        { connected: Boolean(bot && status === 'connected') },
        bot ?? { id: botId },
        {
          onChat: () => {
            void openBot(botId)
              .then((opened) => {
                if (!opened) {
                  showRosterFallback();
                  return;
                }
                requestSurface({ kind: 'bot', botId });
                router.navigate('/chat');
              })
              .catch(() => showRosterFallback());
          },
          onDetail: showRosterFallback,
        },
      );
      open?.();
      return;
    }
    // The pure handshake decision gates the tap: a live gateway, an attempt
    // already in flight (this one's or a rival's) and an unresolved pairing
    // each refuse a second handshake; a settled gateway starts one.
    const gateway = gateways.find((candidate) => candidate.id === node.gatewayId);
    const handshake = gatewayHandshake({
      gatewayName: node.label,
      gatewayId: node.gatewayId,
      connectedGatewayId: status === 'connected' ? activeGateway?.id : undefined,
      activeGatewayId: activeGateway?.id,
      activeGatewayName: activeGateway?.name,
      status,
    });
    if (!gateway || !handshake.canConnect) return;
    void connectGateway(gateway);
  };

  const handlePressApproval = () => {
    router.push('/activity');
  };

  // The long-pressed Bot star's detail sheet: the node and its roster row
  // fold through the same pure view-model the sheet renders, and Open Chat
  // is the tap's own decision (botTap) replayed — never an unconditional
  // open for a Bot the verdict refuses.
  const [botSheet, setBotSheet] = useState<BotSheetView | null>(null);

  const handleLongPressNode = (node: ConstellationNode) => {
    if (node.kind !== 'bot') return;
    const bot = connectedRoster.find((candidate) => candidate.id === node.botId);
    setBotSheet(
      botSheetView({
        node: {
          label: node.label,
          botId: node.botId,
          runningRunName: node.runningRunName,
          badges: node.badges,
        },
        bot: bot ?? null,
      }),
    );
  };

  const openBotSheetChat = () => {
    const botId = botSheet?.id;
    if (!botId) return;
    setBotSheet(null);
    const bot = connectedRoster.find((candidate) => candidate.id === botId);
    botTap(
      { connected: Boolean(bot && status === 'connected') },
      bot ?? { id: botId },
      {
        onChat: () => {
          void openBot(botId)
            .then((opened) => {
              if (!opened) {
                showRosterFallback();
                return;
              }
              requestSurface({ kind: 'bot', botId });
              router.navigate('/chat');
            })
            .catch(() => showRosterFallback());
        },
        onDetail: showRosterFallback,
      },
    )?.();
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
          onLongPressNode={handleLongPressNode}
          onPressApproval={handlePressApproval}
          gatewayStatus={handshakeStatus}
        />
      </ScrollView>
      <FleetBotSheet view={botSheet} onClose={() => setBotSheet(null)} onOpenChat={openBotSheetChat} />
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
