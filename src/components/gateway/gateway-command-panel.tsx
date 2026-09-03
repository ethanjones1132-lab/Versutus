import { StyleSheet, View } from 'react-native';

import { Button, Card, Text } from '@/components/ui';
import { Palette, Radius, Spacing } from '@/constants/tokens';
import type { GatewayCommand } from '@/lib/gateway/dashboard';
import { commandPanelCaption } from '@/lib/gateway/command-panel';

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
  return (
    <Card padding={Spacing.three} style={styles.card}>
      <View style={styles.header}>
        <Text variant="caption" style={styles.onGlassPrimary}>{title}</Text>
        {lastSummary ? (
          <Button label="Raw" variant="ghost" onPress={onOpenOutput} style={styles.rawButton} />
        ) : null}
      </View>

      <View style={styles.commandGrid}>
        {commands.map((command) => {
          // The caption names the call the entry already carries; entries
          // that name none keep today's label-only button.
          const caption = commandPanelCaption(command);
          return (
            <View key={command.id} style={styles.commandCell}>
              <Button
                label={runningCommandId === command.id ? 'Running' : command.label}
                onPress={() => onRun(command)}
                disabled={!!runningCommandId}
                variant={command.danger === 'write' ? 'secondary' : 'primary'}
                style={styles.commandButton}
              />
              {caption ? (
                <Text
                  variant="caption"
                  numberOfLines={1}
                  maxFontSizeMultiplier={1.3}
                  style={[styles.onGlassSecondary, styles.commandCaption]}>
                  {caption}
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>

      <Text variant="caption" style={lastSummary ? styles.onGlassSecondary : styles.onGlassTertiary}>
        {lastSummary ?? 'Run a safe gateway command to inspect the live setup.'}
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.md,
    gap: Spacing.two,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  commandGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  commandButton: {
    minWidth: 104,
    minHeight: 44,
    flexGrow: 1,
  },
  commandCell: {
    minWidth: 104,
    flexGrow: 1,
    gap: Spacing.one,
  },
  commandCaption: {
    textAlign: 'center',
  },
  rawButton: {
    minHeight: 34,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
  onGlassPrimary: {
    color: Palette.textPrimary,
  },
  onGlassSecondary: {
    color: Palette.textSecondary,
  },
  onGlassTertiary: {
    color: Palette.textTertiary,
  },
});
