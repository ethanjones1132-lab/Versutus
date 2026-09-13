import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Badge, Button, Card, Text } from '@/components/ui';
import { Palette, Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { approvalClassLabel, approvalInboxCopy, batchApprovableRows } from '@/lib/gateway/approvals';

/**
 * D1: the approval inbox. Lists the Gate's pending approvals with the class
 * the Gate assigned each one, and decides them from here — an approval no
 * longer requires the run that raised it to be open. The class is advisory
 * (the Gate already fails closed); the inbox adds no policy of its own.
 */
export function ApprovalInbox() {
  const { pendingApprovals, decideApproval, approvalBusy } = useGateway();
  const [batchBusy, setBatchBusy] = useState(false);
  // Fail closed: a batch Approve can only cover read-only rows.
  const approvable = batchApprovableRows(pendingApprovals);

  const decideAll = async (ids: string[], decision: 'approve' | 'deny') => {
    setBatchBusy(true);
    try {
      for (const id of ids) await decideApproval(id, decision);
    } finally {
      setBatchBusy(false);
    }
  };

  return (
    <Card padding={Spacing.three} style={styles.card}>
      <View style={styles.header}>
        <Text variant="body">Approvals</Text>
        <Badge
          label={String(pendingApprovals.length)}
          tone={pendingApprovals.length > 0 ? 'accent' : 'neutral'}
        />
      </View>

      {pendingApprovals.length === 0 ? (
        <Text variant="caption" color="secondary">
          No approvals are waiting.
        </Text>
      ) : (
        <>
          {pendingApprovals.length > 1 ? (
            <View style={styles.actions}>
              {approvable.length > 0 ? (
                <Button
                  label={`Approve ${approvable.length} read-only`}
                  size="sm"
                  disabled={batchBusy}
                  onPress={() => void decideAll(approvable.map((row) => row.approvalId), 'approve')}
                />
              ) : null}
              <Button
                label="Deny all"
                size="sm"
                variant="secondary"
                disabled={batchBusy}
                onPress={() => void decideAll(pendingApprovals.map((row) => row.approvalId), 'deny')}
              />
            </View>
          ) : null}
          {pendingApprovals.map((row) => (
            <View key={row.approvalId} style={styles.row}>
              <Text variant="caption">{approvalInboxCopy(row)}</Text>
              <Text variant="micro" color="tertiary">
                {approvalClassLabel(row.cls)}
                {row.operation ? ` · ${row.operation}` : ''}
              </Text>
              <View style={styles.actions}>
                <Button
                  label="Approve"
                  size="sm"
                  onPress={() => void decideApproval(row.approvalId, 'approve')}
                  disabled={approvalBusy === row.approvalId}
                />
                <Button
                  label="Deny"
                  size="sm"
                  variant="secondary"
                  onPress={() => void decideApproval(row.approvalId, 'deny')}
                  disabled={approvalBusy === row.approvalId}
                />
              </View>
            </View>
          ))}
        </>
      )}
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
  row: {
    gap: Spacing.one,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Palette.border,
    paddingTop: Spacing.two,
  },
  actions: { flexDirection: 'row', gap: Spacing.two },
});
