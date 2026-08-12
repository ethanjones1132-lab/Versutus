import { useMemo } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { ConnectionTimeline } from '@/components/connection-timeline';
import { phaseToStepIndex } from '@/lib/connection/phase';

import { ConnectionBadge } from '@/components/connection-badge';
import { Button, Card, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import type { ConnectionPhase } from '@/context/gateway-provider';
import { useTokens } from '@/hooks/use-tokens';
import type { ConnectionStatus } from '@/lib/gateway/types';

export function HomeStatusCard({
  pcName,
  phase,
  status,
  statusDetail,
  probeMessage,
  onConnect,
  onOpenChat,
}: {
  pcName?: string;
  phase: ConnectionPhase;
  status: ConnectionStatus;
  statusDetail: string;
  probeMessage?: string;
  onConnect: () => void;
  onOpenChat?: () => void;
}) {
  const tokens = useTokens();
  const isBusy = phase === 'searching' || phase === 'connecting' || status === 'connecting';
  const isConnected = status === 'connected';
  const needsPairing = status === 'pairing';
  const title = pcName ?? 'Your gateway PC';
  const message = phaseMessage(phase, probeMessage, statusDetail);
  const activeStep = phaseToStepIndex(phase, status);
  const showStepper = activeStep >= 0 && phase !== 'onboarding' && phase !== 'idle' && phase !== 'booting';

  const contentKey = useMemo(() => `${phase}:${status}:${message}`, [message, phase, status]);

  return (
    <Card
      variant="hero"
      padding={Spacing.four}
      style={[styles.card, { borderColor: tokens.borderStrong }]}>
      <View style={[styles.metalRule, { backgroundColor: tokens.accentWarm }]} />
      <View style={styles.header}>
        <View style={styles.titleBlock}>
          <Text variant="caption" color="accentWarm" style={styles.eyebrow}>
            Versutus link
          </Text>
          <Text variant="headline">{title}</Text>
        </View>
        <ConnectionBadge status={status} />
      </View>

      {showStepper ? (
        <ConnectionTimeline
          activeStep={activeStep}
          failed={phase === 'failed'}
          busy={isBusy}
        />
      ) : null}

      <View key={contentKey} style={styles.content}>
        <Text color="secondary" style={styles.subtitle}>
          {message}
        </Text>

        {isBusy ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={tokens.accentWarm} />
            <Text color="secondary">Working in the background…</Text>
          </View>
        ) : null}

        {isConnected ? (
          <Button label="Open chat" onPress={onOpenChat} style={styles.cta} />
        ) : needsPairing ? (
          <Text color="secondary">Approve this phone on your PC — details are on the Chat tab.</Text>
        ) : (
          <Button
            label={phase === 'failed' ? 'Try again' : 'Connect now'}
            onPress={onConnect}
            disabled={isBusy}
            style={styles.cta}
          />
        )}
      </View>
    </Card>
  );
}

function phaseMessage(phase: ConnectionPhase, probeMessage?: string, statusDetail?: string): string {
  if (probeMessage) return probeMessage;
  if (statusDetail && phase !== 'idle') return statusDetail;
  switch (phase) {
    case 'searching':
      return 'Looking for your gateway over Tailscale and local network…';
    case 'connecting':
      return 'Connecting to your agent…';
    case 'connected':
      return 'You are connected. Chat is ready.';
    case 'pairing':
      return 'Almost there — approve this device once on your PC.';
    case 'failed':
      return 'Could not reach your gateway. Make sure it is running, then tap Retry. Check Tailscale or local network.';
    case 'onboarding':
      return 'Set up your PC to get started.';
    default:
      return 'Versutus connects to Hermes, Gate, or OpenClaw on your PC over Tailscale — automatically when possible.';
  }
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.xl,
    gap: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
  },
  metalRule: {
    height: StyleSheet.hairlineWidth,
    opacity: 0.5,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  titleBlock: {
    flex: 1,
    minWidth: 0,
    gap: Spacing.one,
  },
  content: {
    gap: Spacing.two,
  },
  eyebrow: {
    textTransform: 'uppercase',
  },
  subtitle: {
    lineHeight: 22,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginTop: Spacing.two,
  },
  cta: {
    marginTop: Spacing.three,
  },
});
