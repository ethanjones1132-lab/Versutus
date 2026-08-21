import { useMemo, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { DayDivider } from '@/components/chat/day-divider';
import { MessageBubble } from '@/components/chat/message-bubble';
import { PreviewScenarioChip } from '@/components/dev/preview-scenario-chip';
import { SlashCommandPalette } from '@/components/chat/slash-command-palette';
import { TlsFingerprintChangeSheet } from '@/components/gateway/tls-fingerprint-change-sheet';
import { GlassCollapsible } from '@/components/glass-collapsible';
import { HomeStatusCard } from '@/components/home-status-card';
import { PairingPanel } from '@/components/pairing-panel';
import { Button, Screen, Text } from '@/components/ui';
import { getSlashCommandSuggestions } from '@/lib/gateway/slash-commands';
import { Spacing } from '@/constants/tokens';
import { entering } from '@/lib/motion/presets';
import { formatDayDivider } from '@/lib/format';
import { useTokens } from '@/hooks/use-tokens';

import {
  MOCK_CHAT_MESSAGES,
  MOCK_DEVICE_ID,
  PREVIEW_SCENARIOS,
  type PreviewScenario,
} from '@/lib/dev/preview-scenarios';

export default function DevPreviewScreen() {
  const tokens = useTokens();
  const [scenarioId, setScenarioId] = useState<PreviewScenario>('idle');
  const [paletteVisible, setPaletteVisible] = useState(false);
  const [tlsVisible, setTlsVisible] = useState(false);
  // Real registry data, no gateway: the palette's whole job is browsing this.
  const previewCommands = useMemo(
    () => getSlashCommandSuggestions('', null, [], {}, [], Number.POSITIVE_INFINITY),
    [],
  );
  const scenario = PREVIEW_SCENARIOS.find((item) => item.id === scenarioId) ?? PREVIEW_SCENARIOS[0];

  // Day-grouped chat rows so the lab shows the divider behaviour that the real
  // FlatList produces between date boundaries.
  const chatRows = useMemo(() => {
    const rows: ReactNode[] = [];
    let lastLabel: string | null = null;
    for (const message of MOCK_CHAT_MESSAGES) {
      const label = message.timestamp ? formatDayDivider(message.timestamp) : null;
      if (label && label !== lastLabel) rows.push(<DayDivider key={`day-${label}`} label={label} />);
      rows.push(<MessageBubble key={message.id} message={message} identity="V" />);
      lastLabel = label;
    }
    return rows;
  }, []);

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text variant="mono" color="accentWarm" style={styles.eyebrow}>
            PHASE 0 · ANDROID PRIMARY
          </Text>
          <Text variant="title">Visual baseline lab</Text>
          <Text color="secondary" style={styles.lede}>
            Mock gateway states for Compose glass, elevation tiers, and motion — no live connection.
          </Text>
          <View style={[styles.rule, { backgroundColor: tokens.accentWarmMuted }]} />
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
          {PREVIEW_SCENARIOS.map((item) => (
            <PreviewScenarioChip
              key={item.id}
              label={item.label}
              active={item.id === scenarioId}
              onPress={() => setScenarioId(item.id)}
            />
          ))}
        </ScrollView>

        <Animated.View key={scenarioId} entering={entering.fadeIn} style={styles.stage}>
          {scenario.id === 'chat-streaming' ? (
            <View style={styles.chatPane}>{chatRows}</View>
          ) : (
            <>
              <HomeStatusCard
                pcName="Studio PC"
                phase={scenario.phase}
                status={scenario.status}
                statusDetail={scenario.statusDetail}
                probeMessage={scenario.probeMessage}
                onConnect={() => undefined}
                onOpenChat={() => undefined}
              />

              {scenario.showPairing ? <PairingPanel deviceId={MOCK_DEVICE_ID} /> : null}

              {scenario.lastError ? (
                <GlassCollapsible title="Troubleshooting">
                  <Text color="secondary">
                    • Hermes or Gate running on your PC{'\n'}• Tailscale connected on both devices{'\n'}• Gateway
                    reachable over tailnet
                  </Text>
                  <Text variant="caption" color="tertiary">
                    {scenario.lastError}
                  </Text>
                </GlassCollapsible>
              ) : null}
            </>
          )}
        </Animated.View>

        <View style={styles.sheetLab}>
          <Text variant="mono" color="accentWarm" style={styles.eyebrow}>
            SHEET LAB
          </Text>
          <Text color="secondary">
            Sheets that normally sit behind a connected gateway, openable here so they can be
            checked without one.
          </Text>
          <Button label="Open command palette" variant="secondary" onPress={() => setPaletteVisible(true)} />
          <Button
            label="Open TLS fingerprint change"
            variant="secondary"
            onPress={() => setTlsVisible(true)}
          />
        </View>

        <View style={[styles.meta, { borderColor: tokens.glassBorder }]}>
          <Text variant="mono" color="tertiary">
            {scenario.phase.toUpperCase()} · {scenario.status.toUpperCase()}
          </Text>
        </View>
      </ScrollView>

      <SlashCommandPalette
        visible={paletteVisible}
        commands={previewCommands}
        onClose={() => setPaletteVisible(false)}
        onSelect={() => undefined}
      />

      <TlsFingerprintChangeSheet
        visible={tlsVisible}
        gatewayLabel="Studio PC"
        previousFingerprint="AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"
        observedFingerprint="99:88:77:66:55:44:33:22:11:00:FF:EE:DD:CC:BB:AA"
        onApprove={() => setTlsVisible(false)}
        onReject={() => setTlsVisible(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  sheetLab: { gap: Spacing.two, marginTop: Spacing.four },
  content: {
    padding: Spacing.three,
    gap: Spacing.three,
    paddingBottom: Spacing.five,
  },
  header: {
    gap: Spacing.two,
    paddingTop: Spacing.two,
  },
  eyebrow: {
    letterSpacing: 1.2,
  },
  lede: {
    lineHeight: 22,
    maxWidth: 340,
  },
  rule: {
    height: 2,
    width: 48,
    borderRadius: 1,
    marginTop: Spacing.one,
  },
  rail: {
    gap: Spacing.two,
    paddingVertical: Spacing.one,
  },
  stage: {
    gap: Spacing.three,
  },
  chatPane: {
    gap: Spacing.two,
  },
  meta: {
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
});