import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Host, ListItem, Text as ComposeText, TextButton } from '@expo/ui/jetpack-compose';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { DeviceIdRow } from '@/components/device-id-row';
import { Card, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import type { PairingDetails } from '@/lib/gateway/types';

type CopyKind = 'id' | 'cmd';

type CopyRowProps = {
  label: string;
  value: string;
  copied: CopyKind | null;
  kind: CopyKind;
  onCopy: (text: string, kind: CopyKind) => void;
};

function CopyRow({ label, value, copied, kind, onCopy }: CopyRowProps) {
  const tokens = useTokens();

  return (
    <View style={styles.step}>
      <Text variant="caption" color="secondary">
        {label}
      </Text>
      <Host matchContents style={styles.copyHost}>
        <ListItem
          colors={{
            containerColor: tokens.backgroundInset,
            contentColor: tokens.textPrimary,
            supportingContentColor: tokens.textSecondary,
          }}
          tonalElevation={0}>
          <ListItem.SupportingContent>
            <ComposeText color={tokens.textPrimary} style={{ fontFamily: 'monospace', fontSize: 12 }}>
              {value}
            </ComposeText>
          </ListItem.SupportingContent>
          <ListItem.TrailingContent>
            <TextButton onClick={() => void onCopy(value, kind)}>
              <ComposeText color={copied === kind ? tokens.accent : tokens.textTertiary} style={{ fontSize: 12 }}>
                {copied === kind ? 'Copied' : 'Copy'}
              </ComposeText>
            </TextButton>
          </ListItem.TrailingContent>
        </ListItem>
      </Host>
    </View>
  );
}

export function PairingPanel({
  deviceId,
  pairingDetails,
}: {
  deviceId: string;
  pairingDetails?: PairingDetails | null;
}) {
  const tokens = useTokens();
  const [copied, setCopied] = useState<CopyKind | null>(null);
  const approveCommand = pairingDetails?.requestId
    ? `openclaw devices approve ${pairingDetails.requestId}`
    : 'openclaw devices approve <requestId>';

  const copyText = useCallback(async (text: string, kind: CopyKind) => {
    await Clipboard.setStringAsync(text);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCopied(kind);
    setTimeout(() => setCopied(null), 2000);
  }, []);

  return (
    <Card
      variant="surface"
      padding={Spacing.three}
      style={[
        styles.panel,
        {
          borderColor: tokens.accentWarm,
          borderWidth: StyleSheet.hairlineWidth * 2,
          borderRadius: Radius.lg,
        },
      ]}>
      <Text variant="headline">Approve this phone on your PC</Text>
      <Text color="secondary">
        One-time setup. On your PC terminal, approve the pending request for this device.
      </Text>
      {pairingDetails?.remediationHint ? (
        <Text color="tertiary" variant="caption">
          {pairingDetails.remediationHint}
        </Text>
      ) : null}

      <View style={styles.steps}>
        <View style={styles.step}>
          <Text variant="caption" color="accentWarm">
            1
          </Text>
          <CopyRow
            label="List pending devices"
            value="openclaw devices list"
            copied={copied}
            kind="cmd"
            onCopy={copyText}
          />
        </View>

        <View style={styles.step}>
          <Text variant="caption" color="accentWarm">
            2
          </Text>
          <CopyRow
            label="Approve this device"
            value={approveCommand}
            copied={copied}
            kind="cmd"
            onCopy={copyText}
          />
          {!pairingDetails?.requestId ? (
            <Text color="tertiary" variant="caption">
              Use the request id shown by the list command.
            </Text>
          ) : null}
        </View>

        <View style={styles.step}>
          <Text variant="caption" color="accentWarm">
            3
          </Text>
          <DeviceIdRow deviceId={deviceId} copied={copied} onCopy={copyText} />
        </View>
      </View>

      <Text color="tertiary" variant="caption">
        Connection will resume automatically after approval.
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: Spacing.two,
  },
  steps: {
    gap: Spacing.three,
  },
  step: {
    gap: Spacing.one,
  },
  copyHost: {
    alignSelf: 'stretch',
    borderRadius: Radius.md,
    overflow: 'hidden',
  },
});