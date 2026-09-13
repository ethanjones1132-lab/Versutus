import { useEffect, useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';

import { Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useTokens } from '@/hooks/use-tokens';
import {
  approvalPolicyCopy,
  approvalPolicyKey,
  loadApprovalPolicies,
  saveApprovalPolicies,
  setApprovalPolicy,
} from '@/lib/gateway/approval-policy';

/**
 * D1: the per-Bot opt-in. The only way to turn auto-approve on — and it can
 * only ever cover read-only commands, which `approvalPolicyDecision` enforces
 * regardless of what this switch says. The policy is THIS device's, keyed by
 * gateway + Bot.
 */
export function BotApprovalPolicyRow({ botId }: { botId: string }) {
  const { activeGateway } = useGateway();
  const tokens = useTokens();
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!activeGateway) return;
    let cancelled = false;
    void loadApprovalPolicies().then((policies) => {
      if (cancelled) return;
      setEnabled(policies[approvalPolicyKey(activeGateway.id, botId)]?.autoApproveRead === true);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [activeGateway, botId]);

  const toggle = async (next: boolean) => {
    if (!activeGateway) return;
    setEnabled(next);
    const policies = await loadApprovalPolicies();
    await saveApprovalPolicies(setApprovalPolicy(policies, activeGateway.id, botId, next));
  };

  if (!activeGateway) return null;

  return (
    <View style={styles.row}>
      <View style={styles.text}>
        <Text variant="micro" color="tertiary">
          APPROVALS
        </Text>
        <Text variant="caption" color="secondary">
          {approvalPolicyCopy(enabled)}
        </Text>
      </View>
      <Switch
        value={enabled}
        onValueChange={(next) => void toggle(next)}
        disabled={!loaded}
        trackColor={{ true: tokens.accent, false: tokens.border }}
        thumbColor={tokens.textPrimary}
        accessibilityLabel="Auto-approve read-only commands for this Bot"
        accessibilityState={{ checked: enabled }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  text: { flex: 1, gap: 2 },
});
