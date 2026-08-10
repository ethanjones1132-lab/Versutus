import * as Haptics from 'expo-haptics';
import { StyleSheet, View } from 'react-native';

import { BaseSheet , PressableScale, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
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

  const riskColor =
    preview.risk === 'high'
      ? tokens.statusDisconnected
      : preview.risk === 'medium'
        ? tokens.accentWarm
        : tokens.statusConnected;

  return (
    <BaseSheet
      visible={visible}
      eyebrow="CONFIRM ACTION"
      onClose={onCancel}
      closeLabel="Dismiss"
      position="bottom"
    >
      <Text variant="title" style={styles.title}>
        {preview.title}
      </Text>

      <Text color="secondary" style={styles.summary}>
        {preview.summary}
      </Text>

      <View style={styles.riskRow}>
        <Text variant="caption" color="tertiary">Risk:</Text>
        <View style={[styles.riskBadge, { backgroundColor: riskColor }]}>
          <Text variant="caption" style={{ color: '#000' }}>
            {preview.risk.toUpperCase()}
          </Text>
        </View>
      </View>

      <View style={styles.section}>
        <Text variant="caption" color="tertiary">Command</Text>
        <Text variant="mono" style={styles.command}>
          {preview.applyCommand}
        </Text>
      </View>

      {preview.diff && preview.diff.length > 0 && (
        <View style={styles.section}>
          <Text variant="caption" color="tertiary">Preview</Text>
          {preview.diff.map((d, i) => (
            <View key={i} style={styles.diff}>
              <Text variant="caption" color="accentWarm">{d.label}</Text>
              <Text variant="mono" style={styles.diffText}>
                - {d.before}
              </Text>
              <Text variant="mono" style={styles.diffText}>
                + {d.after}
              </Text>
            </View>
          ))}
        </View>
      )}

      <Text variant="caption" color="tertiary" style={styles.note}>
        This action will be executed on the gateway. Use --confirm in chat for advanced bypass.
      </Text>

      <View style={styles.footer}>
        <PressableScale 
          style={styles.cancelBtn} 
          onPress={async () => {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onCancel();
          }}>
          <Text variant="caption">Cancel</Text>
        </PressableScale>
        <PressableScale
          style={[styles.confirmBtn, { backgroundColor: tokens.accentWarm }]}
          onPress={async () => {
            await Haptics.notificationAsync(
              preview.risk === 'high'
                ? Haptics.NotificationFeedbackType.Warning
                : Haptics.NotificationFeedbackType.Success,
            );
            onConfirm();
          }}>
          <Text variant="caption" style={{ color: '#111' }}>
            {confirmLabelForPreview(preview)}
          </Text>
        </PressableScale>
      </View>
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  title: {
    color: '#fff',
  },
  summary: {
    fontSize: 15,
    lineHeight: 20,
  },
  riskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  riskBadge: {
    paddingHorizontal: Spacing.one,
    paddingVertical: 2,
    borderRadius: 4,
  },
  section: {
    gap: Spacing.one,
    marginTop: Spacing.one,
  },
  command: {
    backgroundColor: 'rgba(0,0,0,0.4)',
    padding: Spacing.two,
    borderRadius: 10,
    fontSize: 13,
  },
  diff: {
    gap: 2,
    padding: Spacing.one,
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderRadius: 8,
  },
  diffText: {
    fontSize: 12,
    color: '#aaa',
  },
  note: {
    fontSize: 11,
    opacity: 0.7,
    marginTop: Spacing.one,
  },
  footer: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingTop: Spacing.three,
    marginTop: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(240,214,144,0.2)',
  },
  cancelBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.two,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  confirmBtn: {
    flex: 2,
    alignItems: 'center',
    paddingVertical: Spacing.two,
    borderRadius: 10,
  },
});
