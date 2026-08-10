import { StyleSheet, View } from 'react-native';

import { Badge, Card, Icon, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { inspectGatewayTransport } from '@/lib/gateway/security';

export function TransportSecurityCard({ url, tlsFingerprint }: { url: string; tlsFingerprint?: string }) {
  const info = inspectGatewayTransport(url, tlsFingerprint);
  const tone = info.isEncrypted ? 'success' : 'warning';

  return (
    <Card variant="inset" padding={Spacing.three} style={styles.card}>
      <View style={styles.header}>
        <Icon
          name={
            info.isEncrypted
              ? { ios: 'lock.fill', android: 'lock', web: 'lock' }
              : { ios: 'exclamationmark.shield', android: 'gpp_bad', web: 'gpp_bad' }
          }
          size={16}
          color={info.isEncrypted ? 'statusConnected' : 'statusConnecting'}
        />
        <Text variant="caption" style={styles.title}>
          Transport security
        </Text>
        <Badge label={info.label} tone={tone} dot={false} />
      </View>
      <Text variant="caption" color="secondary">
        {info.detail}
      </Text>
      {tlsFingerprint ? (
        <Text variant="mono" color="tertiary" numberOfLines={2}>
          Observed fingerprint: {tlsFingerprint}
        </Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.lg,
    gap: Spacing.two,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  title: {
    flex: 1,
  },
});
