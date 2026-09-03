import { useCallback, useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';

import { Card, ListRow, Skeleton, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import {
  applyToolsetsRead,
  EMPTY_TOOLSETS,
  toolsetsListCopy,
  toolsetsReadFromUnknown,
  type ToolsetsRead,
  type ToolsetsState,
} from '@/lib/gateway/toolsets';

/**
 * The Gateway's toolset catalog. Read-only — the Gate answers `tools.list`
 * (GET /v1/toolsets, the raw `listToolsets` result) and this block renders
 * each toolset with its one-line description. A rejected read names the
 * failure instead of telling an empty "no tools" story.
 */
export function ToolsetsSection() {
  const { status, gatewayRequest, activeGateway } = useGateway();
  const [state, setState] = useState<ToolsetsState & { gatewayId?: string }>(EMPTY_TOOLSETS);
  const [error, setError] = useState<string | null>(null);
  const gatewayId = activeGateway?.id;
  const visible = status === 'connected' && !!gatewayId;

  const load = useCallback(async () => {
    if (!visible || !gatewayId) return;
    const fold = (read: ToolsetsRead) => {
      setState((previous) => {
        const base = previous.gatewayId === gatewayId ? previous : EMPTY_TOOLSETS;
        return { ...applyToolsetsRead(base, read), gatewayId };
      });
    };
    try {
      const payload = await gatewayRequest('tools.list', {});
      const read = toolsetsReadFromUnknown(payload);
      fold(read);
      // A junk envelope parses as a failed read with no thrown message —
      // keep the lib's honest copy for that shape, and only clear a prior
      // named failure on a read that actually parsed.
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

  if (!visible) return null;

  const shown = state.gatewayId === gatewayId ? state : EMPTY_TOOLSETS;
  const copy = toolsetsListCopy(shown);

  return (
    <Card padding={Spacing.three} style={styles.card}>
      <Text variant="title">Toolsets</Text>
      {!shown.loaded && !shown.failed ? (
        <>
          <Skeleton width="90%" height={44} />
          <Skeleton width="76%" height={44} style={styles.gap} />
        </>
      ) : null}
      {error && !shown.loaded ? (
        <Text variant="micro" color="statusDisconnected" selectable>
          {error}
        </Text>
      ) : null}
      {copy ? (
        <Text variant="micro" color="secondary">
          {copy}
        </Text>
      ) : null}
      {shown.toolsets.map((toolset) => (
        <ListRow
          key={toolset.name}
          title={toolset.name}
          subtitle={toolset.description || undefined}
          style={styles.row}
        />
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: Spacing.two },
  row: { marginBottom: Spacing.one },
  gap: { marginTop: Spacing.two },
});
