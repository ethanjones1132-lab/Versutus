import { useState } from 'react';
import { StyleSheet } from 'react-native';

import { Button, Card, ListRow, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { GATEWAY_COMMANDS } from '@/lib/gateway/dashboard';
import {
  buildRpcMethodSlashMap,
  normalizeRpcMethods,
  rpcMethodsListCopy,
  rpcMethodsToggleLabel,
  rpcMethodSlash,
} from '@/lib/gateway/rpc-methods';
import { manifestDynamicCommands } from '@/lib/portal/manifest';

/**
 * The live RPC dispatch table the snapshot block judges every slash command
 * by. Display only — the manifest's `rpcMethods` array is already held on
 * the capability snapshot, so this section reads it with no new fetch.
 * Each row names the slash that speaks it from the already-held registry
 * (dashboard commands plus this gateway's dynamic instance commands);
 * a method the registry does not know keeps today's bare name, never a guess.
 * Collapsed by default; an absent table reads "unknown", never "none".
 */
export function RpcMethodsSection() {
  const { status, activeGateway, activeManifest, capabilitySnapshot } = useGateway();
  // Which gateway the toggle was opened for. Changing gateways collapses by
  // derivation instead of an effect setState, so each gateway starts closed.
  const [openFor, setOpenFor] = useState<string | null>(null);
  const gatewayId = activeGateway?.id;
  const visible = status === 'connected' && !!gatewayId;

  if (!visible) return null;

  const open = openFor !== null && openFor === gatewayId;
  const methods = normalizeRpcMethods(capabilitySnapshot.rpcMethods);
  const copy = rpcMethodsListCopy(methods);
  const toggleLabel = rpcMethodsToggleLabel(open, methods?.length);
  // Already held on this device: the static dashboard registry plus the
  // dynamic commands this gateway's manifest contributes. No new fetch.
  const slashMap = buildRpcMethodSlashMap([
    ...(activeManifest ? manifestDynamicCommands(activeManifest) : []),
    ...GATEWAY_COMMANDS,
  ]);

  return (
    <Card padding={Spacing.three} style={styles.card}>
      <Text variant="title">Answered RPC methods</Text>
      <Text variant="caption" color="secondary">
        The live dispatch table this gateway judges slash commands by.
      </Text>
      <Button label={toggleLabel} variant="ghost" onPress={() => setOpenFor(open ? null : (gatewayId ?? null))} />
      {open ? (
        copy ? (
          <Text variant="micro" color="secondary">
            {copy}
          </Text>
        ) : (
          (methods ?? []).map((method) => <ListRow key={method} title={method} subtitle={rpcMethodSlash(method, slashMap)} style={styles.row} />)
        )
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: Spacing.two },
  row: { marginBottom: Spacing.one },
});
