import { AssistChip, Host, Text as ComposeText, TextButton } from '@expo/ui/jetpack-compose';
import * as Haptics from 'expo-haptics';
import { StyleSheet, View } from 'react-native';

import { Card, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import type { GatewayCommand } from '@/lib/gateway/dashboard';

export function GatewayCommandPanel({
  title = 'Quick commands',
  commands,
  runningCommandId,
  lastSummary,
  onRun,
  onOpenOutput,
}: {
  title?: string;
  commands: GatewayCommand[];
  runningCommandId?: string | null;
  lastSummary?: string;
  onRun: (command: GatewayCommand) => void;
  onOpenOutput?: () => void;
}) {
  const tokens = useTokens();

  return (
    <Card padding={Spacing.two} style={[styles.card, { borderColor: tokens.glassBorder }]}>
      <View style={styles.header}>
        <Text variant="caption" color="accentWarm" style={styles.title}>
          {title}
        </Text>
        {lastSummary ? (
          <Host matchContents style={styles.rawHost}>
            <TextButton
              onClick={async () => {
                await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onOpenOutput?.();
              }}>
              <ComposeText color={tokens.accent} style={{ fontSize: 12, fontWeight: '600' }}>
                View raw
              </ComposeText>
            </TextButton>
          </Host>
        ) : null}
      </View>

      <View style={styles.commandGrid}>
        {commands.map((command) => {
          const isRunning = runningCommandId === command.id;
          const isDanger = command.danger === 'write' || command.danger === 'destructive';
          return (
            <Host key={command.id} matchContents style={styles.chipHost}>
              <AssistChip
                enabled={!runningCommandId}
                onClick={async () => {
                  await Haptics.impactAsync(
                    isDanger
                      ? Haptics.ImpactFeedbackStyle.Medium
                      : Haptics.ImpactFeedbackStyle.Light,
                  );
                  onRun(command);
                }}
                colors={{
                  containerColor: isDanger ? tokens.accentWarmMuted : tokens.backgroundElevated,
                  labelColor: isRunning ? tokens.statusConnecting : tokens.textPrimary,
                }}>
                <AssistChip.Label>
                  <ComposeText
                    color={isRunning ? tokens.statusConnecting : tokens.textPrimary}
                    style={{ fontSize: 13, fontWeight: '500' }}>
                    {isRunning ? 'Running…' : command.label}
                  </ComposeText>
                </AssistChip.Label>
              </AssistChip>
            </Host>
          );
        })}
      </View>

      <Text variant="caption" color={lastSummary ? 'secondary' : 'tertiary'}>
        {lastSummary ?? 'Run a safe gateway command to inspect the live setup.'}
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.md,
    gap: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  title: {
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  rawHost: {
    alignSelf: 'flex-start',
  },
  commandGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  chipHost: {
    alignSelf: 'flex-start',
  },
});