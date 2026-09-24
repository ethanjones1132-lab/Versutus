import { ScrollView, StyleSheet, View } from 'react-native';

import { Card, ErrorCard, PressableScale, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { councilSummaryCopy, type CouncilColumn } from '@/lib/gateway/council';

export type CouncilCompareViewProps = {
  /** The result `runCouncil` returned — this view never re-runs a send. */
  columns: CouncilColumn[];
  /** A column tap opens that Bot's chat. A failed column has no chat to open. */
  onPressColumn?: (column: CouncilColumn) => void;
};

const COLUMN_WIDTH = 240;

/**
 * D7's comparison: one column per Bot, side by side. A failed Bot keeps its own
 * column and names its error, so one Bot going quiet never hides behind the
 * summary — the whole point of per-column isolation.
 *
 * Presentational and transport-free: it draws the shipped `CouncilColumn[]` and
 * asks its host where a column tap goes. Only an answered column is a press
 * target — a failed or silent one has nowhere to open, so it draws as content
 * rather than a button that no-ops.
 */
export function CouncilCompareView({ columns, onPressColumn }: CouncilCompareViewProps) {
  return (
    <View style={styles.root}>
      <Text variant="caption" color="secondary">
        {councilSummaryCopy(columns)}
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}>
        {columns.map((column) => {
          const answered = column.state === 'answered';
          const stateWord = answered
            ? 'answered'
            : column.state === 'silent'
              ? 'had nothing to add'
              : 'failed';
          const card = (
            <Card variant="surface" padding={Spacing.three} style={styles.card}>
              <Text variant="micro" color="accent" numberOfLines={1}>
                {column.label}
              </Text>
              {column.state === 'failed' ? (
                <ErrorCard
                  cause={column.error}
                  affected={`${column.label}'s answer`}
                  next="Retry the comparison when the gateway is reachable."
                />
              ) : column.state === 'silent' ? (
                <Text variant="caption" color="secondary">
                  Nothing to add
                </Text>
              ) : (
                <Text variant="body" color="secondary">
                  {column.text}
                </Text>
              )}
            </Card>
          );
          if (!answered) {
            return (
              <View key={column.botId} style={styles.column} accessibilityLabel={`${column.label}, ${stateWord}`}>
                {card}
              </View>
            );
          }
          return (
            <PressableScale
              key={column.botId}
              onPress={() => onPressColumn?.(column)}
              accessibilityRole="button"
              accessibilityLabel={`${column.label}, ${stateWord}`}
              style={styles.column}>
              {card}
            </PressableScale>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: Spacing.two,
  },
  row: {
    gap: Spacing.three,
    paddingVertical: Spacing.one,
  },
  column: {
    width: COLUMN_WIDTH,
  },
  card: {
    gap: Spacing.two,
    minHeight: 160,
  },
});
