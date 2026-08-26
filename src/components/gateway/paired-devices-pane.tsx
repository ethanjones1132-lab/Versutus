import { useCallback, useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';

import { Badge, Card, ListRow, Skeleton, Text } from '@/components/ui';
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
 * Devices that hold a token on this Gate. Read-only — revoke is a later
 * slice and needs a confirm. The token itself is never shown.
 */
export function PairedDevicesPane() {
  const { status, gatewayRequest, activeGateway } = useGateway();
  const [state, setState] = useState<PairedDevicesState & { gatewayId?: string }>(EMPTY_PAIRED_DEVICES);
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
      {shown.devices.map((device) => {
        const row = pairedDeviceRowCopy(device);
        return (
          <ListRow
            key={device.deviceId}
            title={row.title}
            subtitle={row.subtitle || undefined}
            trailing={
              row.revoked ? (
                <Badge label="revoked" tone="danger" />
              ) : (
                <Badge label="active" tone="success" />
              )
            }
            style={styles.row}
          />
        );
      })}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: Spacing.two },
  row: { marginBottom: Spacing.one },
  gap: { marginTop: Spacing.two },
});
