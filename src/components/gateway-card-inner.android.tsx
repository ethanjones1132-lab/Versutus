import * as Haptics from 'expo-haptics';
import { StyleSheet, View } from 'react-native';

import { ConnectionBadge } from '@/components/connection-badge';
import { Button, Card, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import type { ConnectionStatus, GatewayProfile } from '@/lib/gateway/types';

export type GatewayCardInnerProps = {
  gateway: GatewayProfile;
  isActive: boolean;
  status: ConnectionStatus;
  statusDetail?: string;
  onConnect: () => void;
  onDelete: () => void;
  showDeleteButton?: boolean;
};

export function GatewayCardInner({
  gateway,
  isActive,
  status,
  statusDetail,
  onConnect,
  onDelete,
  showDeleteButton = true,
}: GatewayCardInnerProps) {
  const tokens = useTokens();

  return (
    <Card
      variant={isActive ? 'hero' : 'surface'}
      padding={Spacing.three}
      style={[
        styles.card,
        isActive && {
          borderColor: tokens.accent,
          borderWidth: StyleSheet.hairlineWidth * 2,
        },
      ]}>
      <View style={styles.header}>
        <View style={styles.titleBlock}>
          <Text variant="caption">{gateway.name}</Text>
          <Text variant="mono" color="secondary">
            {gateway.url}
          </Text>
          <Text variant="caption" color="tertiary">
            {gateway.sessionKey}
            {gateway.discoverySource === 'tailscale' || gateway.url.startsWith('wss://')
              ? ' · Tailscale/TLS'
              : ''}
          </Text>
        </View>
        {isActive ? <ConnectionBadge status={status} detail={statusDetail} /> : null}
      </View>

      <View style={styles.actions}>
        <Button
          label={isActive ? 'Reconnect' : 'Connect'}
          onPress={async () => {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onConnect();
          }}
          style={styles.actionButton}
        />
        {showDeleteButton ? (
          <Button
            label="Remove"
            variant="destructive"
            onPress={async () => {
              await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
              onDelete();
            }}
            style={styles.actionButton}
          />
        ) : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.lg,
    gap: Spacing.three,
  },
  header: {
    gap: Spacing.two,
  },
  titleBlock: {
    gap: Spacing.one,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  actionButton: {
    flex: 1,
  },
});