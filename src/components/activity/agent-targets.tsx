import { StyleSheet, View } from 'react-native';

import { Badge, EmptyState, ListRow, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
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
 * that the API cannot enumerate — in the operator's words: the gateways they
 * saved, which one is live, and a tap to switch.
 */
export function AgentTargets({ gateways, activeGatewayId, status, onSelect }: AgentTargetsProps) {
  const tokens = useTokens();

  return (
    <View style={styles.root}>
      <View style={[styles.group, { backgroundColor: tokens.stagePanel }]}>
        {gateways.length === 0 ? (
          <EmptyState
            icon={{ ios: 'person.2', android: 'group', web: 'group' }}
            title="No gateways saved"
            description="Add a gateway to give your Bots a place to run."
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
                style={styles.row}
              />
            );
          })
        )}
      </View>
      <Text variant="caption" color="tertiary" style={styles.note}>
        Each saved gateway is its own place for Bots to run. Tap one to switch to it.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: Spacing.two,
  },
  group: {
    borderRadius: Radius.lg,
    overflow: 'hidden',
    paddingVertical: Spacing.one,
  },
  row: {
    paddingHorizontal: Spacing.three - 4,
  },
  note: {
    paddingHorizontal: Spacing.one,
    lineHeight: 18,
  },
});
