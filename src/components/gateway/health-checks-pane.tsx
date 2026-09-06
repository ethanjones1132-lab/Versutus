import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Badge, Button, Card, ListRow, Skeleton, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import {
  applyDiagnosticsRead,
  EMPTY_DIAGNOSTICS,
  healthCheckRowCopy,
  healthChecksListCopy,
  healthChecksTitle,
  healthChecksVisibleOn,
  healthCheckTone,
  diagnosticsReadFromUnknown,
  type DiagnosticsRead,
  type DiagnosticsState,
} from '@/lib/gateway/diagnostics-read';

/**
 * Named checks from GET /health/detailed. This is the gateway's own
 * snapshot, not the phone runtime screen at /gateway/diagnostics.
 */
export function HealthChecksPane() {
  const { status, gatewayRequest, activeGateway } = useGateway();
  const [state, setState] = useState<DiagnosticsState & { gatewayId?: string }>(EMPTY_DIAGNOSTICS);
  const gatewayId = activeGateway?.id;
  const visible =
    status === 'connected' && !!gatewayId && healthChecksVisibleOn({ kind: activeGateway?.kind });

  const load = useCallback(async () => {
    if (!visible || !gatewayId) return;
    const fold = (read: DiagnosticsRead) => {
      setState((previous) => {
        const base = previous.gatewayId === gatewayId ? previous : EMPTY_DIAGNOSTICS;
        return { ...applyDiagnosticsRead(base, read), gatewayId };
      });
    };
    try {
      const payload = await gatewayRequest('diagnostics.full');
      fold(diagnosticsReadFromUnknown(payload));
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

  const shown = state.gatewayId === gatewayId ? state : EMPTY_DIAGNOSTICS;
  const copy = healthChecksListCopy(shown);

  return (
    <Card padding={Spacing.three} style={styles.card}>
      <View style={styles.header}>
        <Text variant="title">{healthChecksTitle(shown)}</Text>
        {shown.loaded && shown.status ? (
          <Badge label={shown.status} tone={healthCheckTone(shown.status)} />
        ) : null}
      </View>
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
      {shown.checks.map((check, index) => {
        const row = healthCheckRowCopy(check);
        return (
          <ListRow
            key={`${check.name}:${index}`}
            title={row.title}
            subtitle={row.subtitle}
            trailing={<Badge label={row.status} tone={row.tone} />}
            style={styles.row}
          />
        );
      })}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: Spacing.two },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  row: { marginBottom: Spacing.one },
  gap: { marginTop: Spacing.two },
});
