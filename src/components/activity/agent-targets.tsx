import { StyleSheet, View } from 'react-native';

import { Badge, Card, Divider, EmptyState, ListRow, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import type { ConnectionStatus, GatewayProfile } from '@/lib/gateway/types';

export type AgentTargetsProps = {
  gateways: GatewayProfile[];
  activeGatewayId?: string;
  status: ConnectionStatus;
  onSelect: (gateway: GatewayProfile) => void;
};

/**
 * Hermes does not expose a remote agent registry. This surface shows the
 * configured gateway-profile targets honestly, rather than inventing agents
 * that the API cannot enumerate.
 */
export function AgentTargets({ gateways, activeGatewayId, status, onSelect }: AgentTargetsProps) {
  const tokens = useTokens();

  return (
    <Card variant="inset" padding={Spacing.two} style={styles.card}>
      <View style={styles.header}>
        <View style={styles.titleGroup}>
          <Text variant="caption" color="accentWarm" style={styles.eyebrow}>
            Gateway targets
          </Text>
          <Text variant="headline">Configured profiles</Text>
        </View>
        <Badge label="Profile-scoped" tone="neutral" dot={false} />
      </View>
      <Text variant="caption" color="tertiary" style={styles.note}>
        Hermes has no remote agent registry — each saved gateway profile is a target. Add profiles separately to switch here.
      </Text>
      <Divider />
      {gateways.length === 0 ? (
        <EmptyState
          icon={{ ios: 'person.2', android: 'group', web: 'group' }}
          title="No configured targets"
          description="Add a gateway profile with an optional agent ID to make a target available."
        />
      ) : (
        gateways.map((gateway) => {
          const active = gateway.id === activeGatewayId;
          const gatewayStatus: ConnectionStatus = active ? status : 'disconnected';
          const subtitle = [gateway.name, gateway.model ?? 'default model'].join(' · ');
          return (
            <ListRow
              key={gateway.id}
              title={gateway.agentId || 'Default agent'}
              subtitle={subtitle}
              statusColor={
                gatewayStatus === 'connected'
                  ? tokens.statusConnected
                  : gatewayStatus === 'connecting' || gatewayStatus === 'reconnecting'
                    ? tokens.statusConnecting
                    : tokens.textTertiary
              }
              trailing={active ? <Badge label="Active" tone="success" dot={false} /> : undefined}
              onPress={() => onSelect(gateway)}
            />
          );
        })
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: Spacing.two,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  titleGroup: {
    flex: 1,
    gap: Spacing.one,
  },
  eyebrow: {
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  note: {
    lineHeight: 19,
  },
});
