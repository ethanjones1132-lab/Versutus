import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { FontFamily, Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { describeCommandResult } from '@/lib/terminal/json-tree';

import { JsonView } from './json-view';

/** Shared structured/plain render for a command log (inline card + sheet). */
export function CommandResultView({ log }: { log: string }) {
  const tokens = useTokens();
  const model = useMemo(() => describeCommandResult(log), [log]);

  if (model.kind === 'empty') return null;

  if (model.kind === 'text') {
    return (
      <Text variant="mono" style={styles.logText}>
        {model.text}
      </Text>
    );
  }

  return (
    <View style={styles.json}>
      {model.signal.failed ? (
        <View style={[styles.exitBadge, { backgroundColor: tokens.statusDisconnectedMuted }]}>
          <Text variant="caption" color="statusDisconnected" style={styles.exitText}>
            {model.signal.label ? `✕ ${model.signal.label}` : '✕ command failed'}
          </Text>
        </View>
      ) : null}
      <JsonView value={model.value} />
    </View>
  );
}

const styles = StyleSheet.create({
  json: {
    gap: Spacing.two,
  },
  exitBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderRadius: Radius.sm,
    flexDirection: 'row',
  },
  exitText: {
    textTransform: 'none',
  },
  logText: {
    fontFamily: FontFamily.mono,
    lineHeight: 18,
  },
});
