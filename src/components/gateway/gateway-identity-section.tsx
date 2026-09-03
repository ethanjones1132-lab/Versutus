import { StyleSheet } from 'react-native';

import { Card, ListRow, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import {
  gatewayIdentityRows,
  gatewayIdentityUnknownNote,
} from '@/lib/gateway/gateway-identity';

/**
 * Which Gate you are connected to. Display only — the connected manifest is
 * already held on the gateway context, so this block reads it with no new
 * fetch. An older Gate that omits fields degrades to an honest unknown note,
 * never a blank block.
 */
export function GatewayIdentitySection() {
  const { status, activeGateway, activeManifest } = useGateway();
  const gatewayId = activeGateway?.id;
  const visible = status === 'connected' && !!gatewayId;

  if (!visible) return null;

  const rows = gatewayIdentityRows(activeManifest);
  const note = gatewayIdentityUnknownNote(activeManifest);

  return (
    <Card padding={Spacing.three} style={styles.card}>
      <Text variant="title">Gateway identity</Text>
      <Text variant="caption" color="secondary">
        The Gate build this screen is reading.
      </Text>
      {rows.map((row) => (
        <ListRow
          key={row.label}
          title={row.value}
          subtitle={row.label}
          style={styles.row}
        />
      ))}
      {note ? (
        <Text variant="micro" color="secondary">
          {note}
        </Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: Spacing.two },
  row: { marginBottom: Spacing.one },
});
