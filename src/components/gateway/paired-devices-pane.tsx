import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Badge, Button, Card, ConfirmSheet, ListRow, Skeleton, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import {
  applyPairedDevicesRead,
  EMPTY_PAIRED_DEVICES,
  pairedDeviceRowCopy,
  pairedDevicesListCopy,
  pairedDevicesReadFromUnknown,
  pairedDevicesToggleLabel,
  pairedDevicesVisibleOn,
  type PairedDevicesRead,
  type PairedDevicesState,
} from '@/lib/gateway/paired-devices';

/**
 * Devices that hold a token on this Gate. The token itself is never shown.
 * An active device can be revoked from a trailing button gated by a
 * destructive ConfirmSheet that calls `device.revoke` and refreshes the
 * list so the row drops to "revoked" without a remount.
 */
export function PairedDevicesPane() {
  const { status, gatewayRequest, activeGateway } = useGateway();
  const [state, setState] = useState<PairedDevicesState & { gatewayId?: string }>(EMPTY_PAIRED_DEVICES);
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  const gatewayId = activeGateway?.id;
  const visible =
    status === 'connected' && !!gatewayId && pairedDevicesVisibleOn({ kind: activeGateway?.kind });

  const load = useCallback(async () => {
    if (!visible || !gatewayId) return;
    const fold = (read: PairedDevicesRead) => {
      setState((previous) => {
        const base = previous.gatewayId === gatewayId ? previous : EMPTY_PAIRED_DEVICES;
        return { ...applyPairedDevicesRead(base, read), gatewayId };
      });
    };
    try {
      const payload = await gatewayRequest('device.list');
      fold(pairedDevicesReadFromUnknown(payload));
    } catch {
      fold({ ok: false });
    }
  }, [gatewayId, gatewayRequest, visible]);

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => {
      void load();
    }, 0);
    return () => clearTimeout(timer);
  }, [load, visible]);

  const executeRevoke = useCallback(async () => {
    const target = revokeTarget;
    if (!target) return;
    try {
      await gatewayRequest('device.revoke', { deviceId: target });
      setRevokeTarget(null);
      void load();
    } catch {
      // device.revoke throws on unknown ids and scope mismatches. Close the
      // sheet and let the next device.list read (or retry from the row)
      // surface the unchanged state — no local optimistic mutation.
      setRevokeTarget(null);
    }
  }, [gatewayRequest, load, revokeTarget]);

  if (!visible) return null;

  const shown = state.gatewayId === gatewayId ? state : EMPTY_PAIRED_DEVICES;
  const copy = pairedDevicesListCopy(shown);

  return (
    <Card padding={Spacing.three} style={styles.card}>
      <Text variant="title">{pairedDevicesToggleLabel(shown, false)}</Text>
      {!shown.loaded && !shown.failed ? (
        <>
          <Skeleton width="90%" height={44} />
          <Skeleton width="76%" height={44} style={styles.gap} />
        </>
      ) : null}
      {copy ? (
        <Text variant="micro" color="secondary">
          {copy}
        </Text>
      ) : null}
      {!shown.loaded && shown.failed ? (
        <Button label="Retry" variant="ghost" size="sm" onPress={() => void load()} />
      ) : null}
      {shown.devices.map((device) => {
        const row = pairedDeviceRowCopy(device);
        return (
          <ListRow
            key={device.deviceId}
            title={row.title}
            subtitle={row.subtitle || undefined}
            trailing={
              <View style={styles.trailing}>
                {row.revoked ? (
                  <Badge label="revoked" tone="danger" />
                ) : (
                  <Badge label="active" tone="success" />
                )}
                {!row.revoked ? (
                  <Button
                    label="Revoke"
                    variant="ghost"
                    size="sm"
                    onPress={() => setRevokeTarget(device.deviceId)}
                    accessibilityHint="Opens a confirmation, then removes this device's token from the Gate. Other paired devices keep working."
                  />
                ) : null}
              </View>
            }
            style={styles.row}
          />
        );
      })}
      <ConfirmSheet
        visible={revokeTarget !== null}
        title="Revoke device?"
        message="This device's token will be removed from the Gate. Any other paired device keeps working."
        confirmLabel="Revoke"
        danger
        onCancel={() => setRevokeTarget(null)}
        onConfirm={executeRevoke}
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: Spacing.two },
  row: { marginBottom: Spacing.one },
  gap: { marginTop: Spacing.two },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
});