import { useId, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

import { BotAvatar } from '@/components/chat/bot-avatar';
import { Button, ErrorCard, Icon, Skeleton, Text } from '@/components/ui';
import { FontFamily, Radius, Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useTokens } from '@/hooks/use-tokens';
import { useBotCrest } from '@/hooks/use-crest-fleet';
import { approvalClassLabel, approvalInboxCopy, batchApprovableRows } from '@/lib/gateway/approvals';
import { BRAND_TONE } from '@/lib/stage/lamp';

const GLOW_W = 260;
const GLOW_H = 180;

/**
 * The one thing on Activity that needs the operator is lit by whoever is
 * asking: a soft pool of the requesting Bot's crest light in the row's upper
 * left, the way the lamp lights a Bot's own thread.
 */
function RequesterGlow({ botId }: { botId?: string }) {
  const id = `ask-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const crest = useBotCrest(botId ?? '');
  const tone = botId ? crest.tone : BRAND_TONE;
  return (
    <View pointerEvents="none" style={styles.glow}>
      <Svg width={GLOW_W} height={GLOW_H}>
        <Defs>
          <RadialGradient id={id} cx="18%" cy="22%" rx="62%" ry="70%" fx="18%" fy="22%">
            <Stop offset="0" stopColor={tone.from} stopOpacity={0.2} />
            <Stop offset="0.5" stopColor={tone.to} stopOpacity={0.08} />
            <Stop offset="1" stopColor={tone.to} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width={GLOW_W} height={GLOW_H} fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

/**
 * D1: the approval inbox. Lists the Gate's pending approvals with the class
 * the Gate assigned each one, and decides them from here — an approval no
 * longer requires the run that raised it to be open. The class is advisory
 * (the Gate already fails closed); the inbox adds no policy of its own.
 */
export function ApprovalInbox() {
  const {
    pendingApprovals,
    pendingApprovalsState,
    pendingApprovalsError,
    refreshPendingApprovals,
    decideApproval,
    approvalBusy,
  } = useGateway();
  const tokens = useTokens();
  const [batchBusy, setBatchBusy] = useState(false);
  // A refused Approve/Deny (single or batch) names the failure here instead
  // of vanishing: decideApproval rejects with no catch at the provider, so
  // the card catches it, keeps the still-pending rows, and says why nothing
  // moved. A later success clears the notice.
  const [decideError, setDecideError] = useState<string | null>(null);
  // Fail closed: a batch Approve can only cover read-only rows.
  const approvable = batchApprovableRows(pendingApprovals);

  const decide = async (approvalId: string, decision: 'approve' | 'deny') => {
    try {
      await decideApproval(approvalId, decision);
      setDecideError(null);
    } catch (caught) {
      setDecideError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const decideAll = async (ids: string[], decision: 'approve' | 'deny') => {
    setBatchBusy(true);
    try {
      for (const id of ids) await decideApproval(id, decision);
      setDecideError(null);
    } catch (caught) {
      setDecideError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBatchBusy(false);
    }
  };

  return (
    <View style={[styles.group, { backgroundColor: tokens.stagePanel }]}>
      {decideError ? (
        <ErrorCard
          cause={decideError}
          affected="This approval decision"
          next="Try the decision again."
          onDismiss={() => setDecideError(null)}
        />
      ) : null}

      {pendingApprovalsState === 'loading' ? (
        <View style={styles.pad}>
          <Skeleton width="80%" height={14} />
          <Skeleton width="56%" height={12} />
        </View>
      ) : null}

      {pendingApprovalsState === 'failed' ? (
        <ErrorCard
          cause={pendingApprovalsError ?? 'Pending approvals could not be read.'}
          affected="The Approvals list"
          next="Retry the read."
          onRetry={() => void refreshPendingApprovals()}
        />
      ) : null}

      {pendingApprovalsState === 'ready' ? (
        pendingApprovals.length === 0 ? (
          <View style={styles.quiet}>
            <Icon name={{ ios: 'checkmark.circle', android: 'check_circle', web: 'check_circle' }} size={18} color="statusConnected" />
            <Text variant="caption" color="secondary">
              No approvals are waiting.
            </Text>
          </View>
        ) : (
          <>
            {pendingApprovals.map((row, index) => (
              <View
                key={row.approvalId}
                style={[
                  styles.row,
                  index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: tokens.borderSubtle } : null,
                ]}>
                <RequesterGlow botId={row.botId} />
                <View style={styles.rowHead}>
                  {row.botId ? (
                    <BotAvatar botId={row.botId} size={40} />
                  ) : (
                    <View style={[styles.shield, { backgroundColor: tokens.backgroundRaised }]}>
                      <Icon name={{ ios: 'checkmark.shield', android: 'verified_user', web: 'verified_user' }} size={16} color="statusConnecting" />
                    </View>
                  )}
                  <View style={styles.rowText}>
                    <Text variant="body" style={styles.summary}>
                      {approvalInboxCopy(row)}
                    </Text>
                    <Text variant="caption" color="tertiary">
                      {approvalClassLabel(row.cls)}
                      {row.operation ? ` · ${row.operation}` : ''}
                    </Text>
                  </View>
                </View>
                <View style={styles.actions}>
                  <Button
                    label="Deny"
                    size="sm"
                    variant="secondary"
                    onPress={() => void decide(row.approvalId, 'deny')}
                    disabled={approvalBusy === row.approvalId}
                    style={styles.action}
                  />
                  <Button
                    label="Approve"
                    size="sm"
                    onPress={() => void decide(row.approvalId, 'approve')}
                    disabled={approvalBusy === row.approvalId}
                    style={styles.action}
                  />
                </View>
              </View>
            ))}
            {pendingApprovals.length > 1 ? (
              <View style={[styles.batch, { borderTopColor: tokens.borderSubtle }]}>
                {approvable.length > 0 ? (
                  <Button
                    label={`Approve ${approvable.length} read-only`}
                    size="sm"
                    variant="ghost"
                    disabled={batchBusy}
                    onPress={() => void decideAll(approvable.map((row) => row.approvalId), 'approve')}
                  />
                ) : null}
                <Button
                  label="Deny all"
                  size="sm"
                  variant="ghost"
                  disabled={batchBusy}
                  onPress={() => void decideAll(pendingApprovals.map((row) => row.approvalId), 'deny')}
                />
              </View>
            ) : null}
          </>
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // One grouped block: each approval is a row, told from the next by a quiet
  // inset rule — the group is the card, the rows are not boxed again.
  group: { borderRadius: Radius.lg, overflow: 'hidden' },
  pad: { padding: Spacing.three, gap: Spacing.two },
  quiet: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.three,
  },
  row: {
    gap: Spacing.three - 4,
    paddingHorizontal: Spacing.three - 2,
    paddingVertical: Spacing.three - 2,
  },
  rowHead: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.three - 4 },
  glow: { position: 'absolute', left: 0, top: 0, width: GLOW_W, height: GLOW_H },
  shield: {
    width: 40,
    height: 40,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  summary: { fontSize: 16, lineHeight: 22, fontFamily: FontFamily.sans },
  actions: { flexDirection: 'row', gap: Spacing.two, paddingLeft: 52 },
  action: { flex: 1 },
  batch: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
