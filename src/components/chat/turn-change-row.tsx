// ─── The per-turn change row ───────────────────────────────────────
// VS-094, slice 3: one quiet line under a finished assistant bubble.
//
// The copy is never invented here — `toTurnChangeSummary` decides it from the
// record, so "changed" and counts exist only where a diff supplied them and a
// turn with no write-like call produces no row at all. Tapping expands the
// per-file list; a stored record that is missing prints one stable line.
//
// Read-only by design (§4): no approve, no reject, no wording that implies a
// change can be undone from here.

import { memo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Icon, PressableScale, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { useTurnChangeRow, type UseTurnChangeRowInput } from '@/hooks/use-turn-change-row';
import type { TurnChangeRowState } from '@/lib/chat/turn-change-row-state';
import type { TurnChangeFile, TurnChangeStatus } from '@/lib/chat/turn-changes';
import { toTurnChangeSummary } from '@/lib/chat/turn-changes';
import { CHIP_HIT_SLOP } from '@/lib/motion/chip-hit-slop';

/** The store answered `null`: one line, stable, never an empty list. */
export const TURN_CHANGE_UNAVAILABLE_LABEL = 'Changes are unavailable for this turn';

/** Tool-only evidence is a call, not a diff; the caption says so. */
export const TURN_CHANGE_TOOL_CAPTION = 'The backend reports tool calls, not a diff';

const STATUS_LABEL: Record<TurnChangeStatus, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  // A write-like call without a diff is a path the turn touched, not proof it
  // changed. The label keeps that distinction visible.
  unknown: 'Touched',
};

const CHEVRON = {
  down: { ios: 'chevron.down', android: 'expand_more', web: 'expand_more' },
  up: { ios: 'chevron.up', android: 'expand_less', web: 'expand_less' },
} as const;

/**
 * Counts for one row, or `null` when the evidence was a tool call.
 *
 * Only a diff supplies additions/deletions, so a tool-only row never wears
 * "+N −M"; a missing half is omitted rather than printed as zero.
 */
export function turnChangeCountsLabel(file: TurnChangeFile): string | null {
  if (file.evidence !== 'diff') return null;
  const parts: string[] = [];
  if (typeof file.additions === 'number') parts.push(`+${file.additions}`);
  if (typeof file.deletions === 'number') parts.push(`\u2212${file.deletions}`);
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * The row itself, with the record already resolved.
 *
 * Kept free of the store so tests can hand it a fixture state directly: a
 * stored record, an `unavailable` answer, or `none`.
 */
export function TurnChangeRowView({ state }: { state: TurnChangeRowState | undefined }) {
  const tokens = useTokens();
  const [expanded, setExpanded] = useState(false);

  // While the read is in flight, or when the turn has no changes at all, the
  // transcript stays exactly as it was: absence is never a zero.
  if (!state || state.status === 'none') return null;

  if (state.status === 'unavailable') {
    return (
      <View style={styles.container}>
        <Text variant="caption" color="tertiary">
          {TURN_CHANGE_UNAVAILABLE_LABEL}
        </Text>
      </View>
    );
  }

  const record = state.record;
  const summary = toTurnChangeSummary(record);
  if (!summary) return null;

  const omitted = record.truncated && record.omitted > 0 ? record.omitted : 0;
  const hasToolEvidence = record.files.some((file) => file.evidence === 'tool');

  return (
    <View style={styles.container}>
      <PressableScale
        onPress={() => setExpanded((open) => !open)}
        accessibilityRole="button"
        accessibilityLabel={summary.label}
        accessibilityState={{ expanded }}
        hitSlop={CHIP_HIT_SLOP}
        style={styles.summary}>
        <Icon
          name={{ ios: 'doc.text', android: 'description', web: 'description' }}
          size={12}
          color="textTertiary"
        />
        <Text variant="caption" color={summary.tone === 'warning' ? 'secondary' : 'tertiary'}>
          {summary.label}
        </Text>
        <Icon
          name={expanded ? CHEVRON.up : CHEVRON.down}
          size={12}
          color="textTertiary"
        />
      </PressableScale>

      {expanded ? (
        <ScrollView
          style={[styles.list, { backgroundColor: tokens.backgroundInset }]}
          contentContainerStyle={styles.listContent}
          nestedScrollEnabled>
          {record.files.map((file) => {
            const counts = turnChangeCountsLabel(file);
            return (
              <View key={file.path} style={styles.fileRow}>
                <Text variant="mono" color="secondary" numberOfLines={1} style={styles.filePath}>
                  {file.path}
                </Text>
                <Text variant="caption" color="tertiary">
                  {STATUS_LABEL[file.status]}
                </Text>
                {counts ? (
                  <Text variant="caption" color="tertiary">
                    {counts}
                  </Text>
                ) : null}
              </View>
            );
          })}
          {/* A capped record names how many paths it dropped. Those paths are
              gone; the row never guesses at them. */}
          {omitted > 0 ? (
            <Text variant="caption" color="tertiary">
              {`and ${omitted} more`}
            </Text>
          ) : null}
          {hasToolEvidence ? (
            <Text variant="micro" color="tertiary">
              {TURN_CHANGE_TOOL_CAPTION}
            </Text>
          ) : null}
        </ScrollView>
      ) : null}
    </View>
  );
}

export type TurnChangeRowProps = UseTurnChangeRowInput;

/**
 * The connected row for one assistant turn.
 *
 * A finished turn reads the store by `turnId`; a streaming one falls back to
 * the journal when the caller supplied `readJournalMeta`. The hook owns the
 * async lifecycle, so this stays a thin renderer.
 */
export const TurnChangeRow = memo(function TurnChangeRow(props: TurnChangeRowProps) {
  const state = useTurnChangeRow(props);
  return <TurnChangeRowView state={state} />;
});

const styles = StyleSheet.create({
  container: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    paddingHorizontal: Spacing.one,
    paddingVertical: Spacing.half,
  },
  summary: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + 2,
  },
  list: {
    borderRadius: Radius.md,
    maxHeight: 260,
  },
  listContent: {
    padding: Spacing.two,
    gap: Spacing.one,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  filePath: {
    flexShrink: 1,
    minWidth: 0,
  },
});
