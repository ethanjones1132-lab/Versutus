import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Badge, Card, ErrorCard, ListRow, Skeleton, Text } from '@/components/ui';
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
import {
  memoryStatusCopy,
  memoryStatusFromUnknown,
  memoryStatusTone,
  type MemoryStatusState,
} from '@/lib/gateway/memory-status';

/**
 * Named checks from GET /health/detailed. This is the gateway's own
 * snapshot, not the phone runtime screen at /gateway/diagnostics.
 */
export function HealthChecksPane() {
  const { status, gatewayRequest, activeGateway } = useGateway();
  const [state, setState] = useState<DiagnosticsState & { gatewayId?: string }>(EMPTY_DIAGNOSTICS);
  // The thrown message from the checks read, kept for the ErrorCard cause —
  // a junk envelope parses as a failed read with no throw and falls back to
  // the lib's honest copy (same contract toolsets-section uses).
  const [error, setError] = useState<string | null>(null);
  // The memory doctor rides the same read as the checks: one on-demand
  // call when the pane loads, folded to one line below. Host-wide — it
  // describes the gateway host's memory, not a single Bot.
  const [memory, setMemory] = useState<{ state?: MemoryStatusState; gatewayId?: string }>({});
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
    const foldMemory = (read: unknown) => {
      setMemory({ state: memoryStatusFromUnknown(read), gatewayId });
    };
    try {
      const payload = await gatewayRequest('diagnostics.full');
      const read = diagnosticsReadFromUnknown(payload);
      fold(read);
      if (read.ok) setError(null);
    } catch (caught) {
      fold({ ok: false });
      setError(caught instanceof Error ? caught.message : String(caught));
    }
    // The doctor read rides on its own success/failure — a gateway that
    // does not serve the method renders the unknown line, never silence
    // dressed as healthy.
    try {
      foldMemory(await gatewayRequest('doctor.memory.status', {}));
    } catch (read) {
      foldMemory(read);
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
        <Text variant="headline">{healthChecksTitle(shown)}</Text>
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
      {/* Any failure — first-read or stale re-read — surfaces through the
          ErrorCard with the kept message (or the lib copy when the envelope
          failed without a throw); the standalone copy is for the empty claim. */}
      {shown.failed ? (
        <ErrorCard
          cause={error ?? copy ?? 'Health checks could not be read.'}
          affected="Health checks on this gateway"
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
      {(() => {
        const memoryState = memory.gatewayId === gatewayId ? memory.state : undefined;
        if (!memoryState) return null;
        return (
          <View style={styles.memoryRow}>
            <Badge label={memoryState.loaded ? memoryState.status ?? '' : '?'} tone={memoryStatusTone(memoryState)} />
            <Text variant="micro" color="secondary" style={{ flexShrink: 1 }}>
              {memoryStatusCopy(memoryState)}
            </Text>
          </View>
        );
      })()}
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
  memoryRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
});
