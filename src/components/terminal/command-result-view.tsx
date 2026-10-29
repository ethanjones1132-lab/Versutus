import { useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { FontFamily, Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { describeCommandResult } from '@/lib/terminal/json-tree';

import { JsonView } from './json-view';

// Inline (preview) results render inside a capped viewport so a long result
// stays reachable on the phone; the sheet renders the full, unbounded output.
// Text scrolls in its own teaser ScrollView; JSON scrolls inside JsonView's
// windowed FlatList, which this cap gives a real viewport.
const RPC_RESULT_PREVIEW_MAX_HEIGHT = 240;

/** Shared structured/plain render for a command log (inline card + sheet). */
export function CommandResultView({ log, preview = false }: { log: string; preview?: boolean }) {
  const tokens = useTokens();
  const model = useMemo(() => describeCommandResult(log), [log]);

  if (model.kind === 'empty') return null;

  if (model.kind === 'text') {
    // The inline card bounds the dump in a capped, scrollable teaser so the
    // tail is reachable, not clipped at eight lines; the sheet path (preview
    // false) keeps the full, unscoped text.
    return preview ? (
      <ScrollView style={styles.previewScroll} nestedScrollEnabled>
        <Text variant="mono" style={styles.logText}>
          {model.text}
        </Text>
      </ScrollView>
    ) : (
      <Text variant="mono" style={styles.logText}>
        {model.text}
      </Text>
    );
  }

  const tree = <JsonView value={model.value} />;

  return (
    <View style={styles.json}>
      {model.signal.failed ? (
        <View style={[styles.exitBadge, { backgroundColor: tokens.statusDisconnectedMuted }]}>
          <Text variant="caption" color="statusDisconnected" style={styles.exitText}>
            {model.signal.label ? `✕ ${model.signal.label}` : '✕ command failed'}
          </Text>
        </View>
      ) : null}
      {/* The inline card caps the tree so JsonView's FlatList owns a bounded
          viewport and keeps its windowing; the sheet (preview false) leaves
          the tree uncapped. The badge stays outside the cap so a failure is
          always visible above the scrolling rows. */}
      {preview ? <View style={styles.jsonPreview}>{tree}</View> : tree}
    </View>
  );
}

const styles = StyleSheet.create({
  json: {
    gap: Spacing.two,
    flexShrink: 1,
  },
  // Only the inline card applies this; the cap is a maxHeight so a short tree
  // still renders at its natural size while a large one gets a scroll viewport.
  jsonPreview: {
    maxHeight: RPC_RESULT_PREVIEW_MAX_HEIGHT,
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
  previewScroll: {
    maxHeight: RPC_RESULT_PREVIEW_MAX_HEIGHT,
  },
});
