import { StyleSheet, View } from 'react-native';

import { Badge, Button, Card, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import type { ProviderSnapshot } from '@/lib/gateway/provider-types';
import { providerUiState } from '@/lib/gateway/provider-state';

export function ProviderCard({
  snapshot,
  onCheck,
  onRefresh,
  onDisconnect,
  onDisable,
  onDelete,
  onSetKey,
  onAuthorize,
}: {
  snapshot: ProviderSnapshot;
  onCheck: () => void;
  onRefresh: () => void;
  onDisconnect: () => void;
  onDisable: () => void;
  onDelete: () => void;
  onSetKey: () => void;
  onAuthorize: () => void;
}) {
  const label = providerUiState(snapshot);
  return (
    <Card padding={Spacing.three} style={styles.card}>
      <Text variant="title">{snapshot.label}</Text>
      <Text variant="caption">{snapshot.id} · {snapshot.mode} · {snapshot.providerType}</Text>
      <View style={styles.row}>
        <Badge label={label} tone={label === 'Ready' ? 'success' : 'neutral'} />
        <Text variant="caption">
          catalog {snapshot.catalog.source}/{snapshot.catalog.state} ({snapshot.catalog.models.length})
        </Text>
      </View>
      {snapshot.readiness.code ? <Text variant="caption">error {snapshot.readiness.code}</Text> : null}
      <View style={styles.actions}>
        <Button label="Set key" variant="secondary" onPress={onSetKey} />
        <Button label="Authorize" variant="secondary" onPress={onAuthorize} />
        <Button label="Check" variant="secondary" onPress={onCheck} />
        <Button label="Refresh" variant="secondary" onPress={onRefresh} />
        <Button label="Disconnect" variant="secondary" onPress={onDisconnect} />
        <Button label="Disable" variant="secondary" onPress={onDisable} />
        <Button label="Delete" variant="secondary" onPress={onDelete} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: Spacing.two, marginBottom: Spacing.three },
  row: { flexDirection: 'row', gap: Spacing.two, alignItems: 'center', flexWrap: 'wrap' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
});
