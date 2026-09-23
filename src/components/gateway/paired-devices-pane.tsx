import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Badge, Button, Card, ConfirmSheet, ErrorCard, ListRow, Skeleton, Text } from '@/components/ui';
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
  // The thrown message from the device.list read, kept for the ErrorCard
  // cause — a junk envelope parses as a failed read with no throw and falls
  // back to the lib's honest copy (same contract toolsets-section uses).
  const [error, setError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
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
      const read = pairedDevicesReadFromUnknown(payload);
      fold(read);
      if (read.ok) setError(null);
    } catch (caught) {
      fold({ ok: false });
      setError(caught instanceof Error ? caught.message : String(caught));
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
    setRevokeError(null);
    try {
      await gatewayRequest('device.revoke', { deviceId: target });
      setRevokeTarget(null);
      void load();
    } catch (caught) {
      // device.revoke throws on unknown ids and scope mismatches. Keep the
      // sheet open and name the Gate's reason so the operator can retry —
      // no local optimistic mutation.
      setRevokeError(caught instanceof Error ? caught.message : String(caught));
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
      {/* Any failure — first-read or stale re-read — surfaces through the
          ErrorCard with the kept message (or the lib copy when the envelope
          failed without a throw); the standalone copy is for the empty claim. */}
      {shown.failed ? (
        <ErrorCard
          cause={error ?? copy ?? 'Paired devices could not be read.'}
          affected="Paired devices on this Gate"
          next={
            shown.loaded
              ? 'Retry to refresh — the list below is the last good read.'
              : 'Retry, or check the Gate log for the failing call.'
          }
          onRetry={() => void load()}
        />
      ) : null}
      {!shown.failed && copy ? (
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
        message={revokeError || "This device's token will be removed from the Gate. Any other paired device keeps working."}
        confirmLabel="Revoke"
        danger
        onCancel={() => {
          setRevokeTarget(null);
          setRevokeError(null);
        }}
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