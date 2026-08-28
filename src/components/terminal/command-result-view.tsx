import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { FontFamily, Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { describeCommandResult } from '@/lib/terminal/json-tree';

import { JsonView } from './json-view';

// Long text results (list/help dumps) render as a bounded teaser in the
// inline RPC card; the sheet renders the full output.
const RPC_RESULT_PREVIEW_LINES = 8;

/** Shared structured/plain render for a command log (inline card + sheet). */
export function CommandResultView({ log, preview = false }: { log: string; preview?: boolean }) {
  const tokens = useTokens();
  const model = useMemo(() => describeCommandResult(log), [log]);

  if (model.kind === 'empty') return null;

  if (model.kind === 'text') {
    return (
      <Text
        variant="mono"
        style={styles.logText}
        numberOfLines={preview ? RPC_RESULT_PREVIEW_LINES : undefined}>
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
    flexShrink: 1,
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
