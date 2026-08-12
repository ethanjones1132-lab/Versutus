import * as Haptics from 'expo-haptics';
import { StyleSheet, View } from 'react-native';

import { Badge, BaseSheet, Button, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import type { GatewayActionPreview } from '@/lib/gateway/types';

function confirmLabelForPreview(preview: GatewayActionPreview): string {
  const cmd = preview.applyCommand.toLowerCase();
  if (cmd.includes('/model set') || cmd.includes('model set')) return 'Apply model';
  if (cmd.includes('devices approve')) return 'Approve device';
  if (cmd.includes('/session')) return 'Switch session';
  return preview.title;
}

export function ConfirmationSheet({
  visible,
  preview,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  preview: GatewayActionPreview | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const tokens = useTokens();

  if (!visible || !preview) return null;

  const riskTone =
    preview.risk === 'high' ? 'danger' : preview.risk === 'medium' ? 'warning' : 'success';

  return (
    <BaseSheet
      visible={visible}
      eyebrow="CONFIRM ACTION"
      onClose={onCancel}
      closeLabel="Dismiss"
      position="bottom">
      <Text variant="title">{preview.title}</Text>

      <Text color="secondary" style={styles.summary}>
        {preview.summary}
      </Text>

      <View style={styles.riskRow}>
        <Text variant="caption" color="tertiary">
          Risk
        </Text>
        <Badge label={preview.risk.toUpperCase()} tone={riskTone} dot={false} />
      </View>

      <View style={styles.section}>
        <Text variant="caption" color="tertiary">
          Command
        </Text>
        <Text
          variant="mono"
          style={[
            styles.command,
            { backgroundColor: tokens.backgroundInset, borderColor: tokens.glassBorder },
          ]}>
          {preview.applyCommand}
        </Text>
      </View>

      {preview.diff && preview.diff.length > 0 ? (
        <View style={styles.section}>
          <Text variant="caption" color="tertiary">
            Preview
          </Text>
          {preview.diff.map((d, i) => (
            <View
              key={i}
              style={[
                styles.diff,
                { backgroundColor: tokens.backgroundInset, borderColor: tokens.glassBorder },
              ]}>
              <Text variant="caption" color="accentWarm">
                {d.label}
              </Text>
              <Text variant="mono" color="tertiary" style={styles.diffText}>
                - {d.before}
              </Text>
              <Text variant="mono" color="secondary" style={styles.diffText}>
                + {d.after}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      <Text variant="caption" color="tertiary" style={styles.note}>
        This action will be executed on the gateway. Use --confirm in chat for advanced bypass.
      </Text>

      <View style={styles.footer}>
        <Button
          label="Cancel"
          variant="secondary"
          onPress={async () => {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onCancel();
          }}
          style={styles.footerButton}
        />
        <Button
          label={confirmLabelForPreview(preview)}
          onPress={async () => {
            await Haptics.notificationAsync(
              preview.risk === 'high'
                ? Haptics.NotificationFeedbackType.Warning
                : Haptics.NotificationFeedbackType.Success,
            );
            onConfirm();
          }}
          style={styles.footerPrimary}
        />
      </View>
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  summary: {
    marginTop: Spacing.one,
    lineHeight: 20,
  },
  riskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    marginTop: Spacing.two,
  },
  section: {
    gap: Spacing.one,
    marginTop: Spacing.two,
  },
  command: {
    padding: Spacing.two,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 13,
  },
  diff: {
    gap: 2,
    padding: Spacing.two,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  diffText: {
    fontSize: 12,
  },
  note: {
    marginTop: Spacing.two,
    opacity: 0.8,
  },
  footer: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingTop: Spacing.three,
    marginTop: Spacing.two,
  },
  footerButton: {
    flex: 1,
  },
  footerPrimary: {
    flex: 2,
  },
});
