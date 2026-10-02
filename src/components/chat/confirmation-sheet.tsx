import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Badge, BaseSheet, Button, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import type { GatewayActionPreview } from '@/lib/gateway/types';
import { haptics } from '@/lib/haptics';

function confirmLabelForPreview(preview: GatewayActionPreview): string {
  const cmd = preview.applyCommand.toLowerCase();
  if (cmd.includes('/model set') || cmd.includes('model set')) return 'Apply model';
  if (cmd.includes('devices approve')) return 'Approve device';
  // abort/compact/fork/restore are not a switch; the command's own title is
  // the honest verb. Other /session verbs keep the switch label.
  if (/\b(abort|compact|fork|restore)\b/.test(cmd)) return preview.title;
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
  const [held, setHeld] = useState(preview);
  if (preview && preview !== held) setHeld(preview);

  const open = visible && !!preview;
  if (!held && !open) return null;
  const shown = preview ?? held;
  if (!shown) return null;

  const riskTone =
    shown.risk === 'high' ? 'danger' : shown.risk === 'medium' ? 'warning' : 'success';

  return (
    <BaseSheet
      visible={open}
      eyebrow="CONFIRM ACTION"
      onClose={onCancel}
      closeLabel="Dismiss"
      position="bottom">
      <Text variant="title">{shown.title}</Text>

      <Text color="secondary" style={styles.summary}>
        {shown.summary}
      </Text>

      <View style={styles.riskRow}>
        <Text variant="caption" color="tertiary">
          Risk
        </Text>
        <Badge label={shown.risk.toUpperCase()} tone={riskTone} dot={false} />
      </View>

      <View style={styles.section}>
        <Text variant="caption" color="tertiary">
          Command
        </Text>
        <Text
          variant="mono"
          style={[
            styles.command,
            { backgroundColor: tokens.backgroundInset, borderColor: tokens.border },
          ]}>
          {shown.applyCommand}
        </Text>
      </View>

      {shown.diff && shown.diff.length > 0 ? (
        <View style={styles.section}>
          <Text variant="caption" color="tertiary">
            Preview
          </Text>
          {shown.diff.map((d, i) => (
            <View
              key={i}
              style={[
                styles.diff,
                { backgroundColor: tokens.backgroundInset, borderColor: tokens.border },
              ]}>
              <Text variant="caption" color="accent">
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
            await haptics.light();
            onCancel();
          }}
          style={styles.footerButton}
        />
        <Button
          label={confirmLabelForPreview(shown)}
          onPress={async () => {
            await (shown.risk === 'high' ? haptics.warning() : haptics.success());
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
