import { StyleSheet, View } from 'react-native';

import { Button, Card, Icon, PressableScale, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import type { GatewayCommand } from '@/lib/gateway/dashboard';
import { commandPanelCaption } from '@/lib/gateway/command-panel';
import { haptics } from '@/lib/haptics';

/**
 * The quick commands a mode offers, as a list: what the command is, the call
 * it makes in mono under it, and a run glyph. A command that writes to the
 * gateway carries an amber mark instead of looking like every other row —
 * the old grid painted the safe reads as the loud violet ones.
 */
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
    <View style={styles.root}>
      <View style={styles.header}>
        <Text variant="eyebrow" color="tertiary">
          {title}
        </Text>
        {lastSummary ? (
          <Button label="Raw" variant="ghost" size="sm" onPress={onOpenOutput} style={styles.rawButton} />
        ) : null}
      </View>

      <Card variant="surface" padding={0} style={styles.card}>
        {commands.map((command, index) => {
          // The caption names the call the entry already carries; entries
          // that name none keep a label-only row.
          const caption = commandPanelCaption(command);
          const running = runningCommandId === command.id;
          const writes = command.danger === 'write';
          return (
            <PressableScale
              key={command.id}
              onPress={async () => {
                await haptics.selection();
                onRun(command);
              }}
              disabled={!!runningCommandId}
              accessibilityRole="button"
              accessibilityLabel={`${running ? 'Running' : command.label}${caption ? `, ${caption}` : ''}${writes ? ', changes the gateway' : ''}`}
              accessibilityState={{ disabled: !!runningCommandId, busy: running }}
              style={[
                styles.row,
                index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: tokens.borderSubtle } : null,
                runningCommandId && !running ? styles.dimmed : null,
              ]}>
              <View style={[styles.tile, { backgroundColor: writes ? tokens.statusConnectingMuted : tokens.backgroundRaised }]}>
                <Icon
                  name={
                    writes
                      ? { ios: 'pencil', android: 'edit', web: 'edit' }
                      : { ios: 'arrow.right', android: 'arrow_forward', web: 'arrow_forward' }
                  }
                  size={14}
                  color={writes ? 'statusConnecting' : 'accent'}
                />
              </View>
              <View style={styles.rowText}>
                <Text variant="callout" numberOfLines={1}>
                  {running ? 'Running' : command.label}
                </Text>
                {caption ? (
                  <Text
                    variant="mono"
                    color="tertiary"
                    numberOfLines={1}
                    maxFontSizeMultiplier={1.3}
                    style={styles.commandCaption}>
                    {caption}
                  </Text>
                ) : null}
              </View>
              <Icon
                name={{ ios: 'play.fill', android: 'play_arrow', web: 'play_arrow' }}
                size={14}
                color={running ? 'accent' : 'textTertiary'}
              />
            </PressableScale>
          );
        })}
      </Card>

      <Text variant="caption" color={lastSummary ? 'secondary' : 'tertiary'} style={styles.summary}>
        {lastSummary ?? 'Run a safe gateway command to inspect the live setup.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: Spacing.two,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    paddingHorizontal: Spacing.one,
    minHeight: 28,
  },
  card: {
    borderRadius: Radius.lg,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three - 4,
    minHeight: 56,
    paddingHorizontal: Spacing.three - 2,
    paddingVertical: Spacing.two,
  },
  dimmed: {
    opacity: 0.5,
  },
  tile: {
    width: 30,
    height: 30,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  commandCaption: {
    fontSize: 12,
    lineHeight: 16,
  },
  rawButton: {
    minHeight: 30,
    paddingHorizontal: Spacing.two,
    paddingVertical: 0,
  },
  summary: {
    paddingHorizontal: Spacing.one,
  },
});
