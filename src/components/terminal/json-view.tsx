import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { FontFamily, Spacing, type SemanticPalette } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import {
  flattenJsonTreeRows,
  jsonTreeNode,
  type JsonPrimitiveKind,
  type JsonTreeRow,
  type JsonTreeNode,
} from '@/lib/terminal/json-tree';

type Props = {
  value: unknown;
  /** How many container levels start expanded. Deeper levels are collapsed. */
  maxDepth?: number;
};

/**
 * Structured, collapsible view of a gateway command's JSON result. Value types
 * are colour-coded, containers toggle on press, and tapping a primitive copies
 * it — replacing the monolithic mono dump without losing the raw shape.
 */
export function JsonView({ value, maxDepth = 2 }: Props) {
  const tokens = useTokens();
  const root = useMemo(() => jsonTreeNode(value), [value]);
  const initial = useMemo(
    () => collectRootPaths(root, maxDepth),
    [root, maxDepth],
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => initial);
  const rows = useMemo(() => flattenJsonTreeRows(root, expanded), [root, expanded]);

  const toggle = (path: string) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const copy = async (text: string) => {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await Clipboard.setStringAsync(text);
  };

  return (
    <View style={styles.root}>
      <FlatList
        data={rows}
        keyExtractor={(row) => row.id}
        renderItem={({ item }) => (
          <JsonTreeRowView row={item} onToggle={toggle} onCopy={copy} tokens={tokens} />
        )}
        removeClippedSubviews
        initialNumToRender={12}
        maxToRenderPerBatch={16}
        windowSize={9}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
      />
    </View>
  );
}

/** Paths of every container at or above `maxDepth` so they start open. */
function collectRootPaths(node: JsonTreeNode, maxDepth: number, path = 'root', depth = 0): Set<string> {
  const paths = new Set<string>();
  if (depth < maxDepth) paths.add(path);
  if (node.kind === 'object') {
    for (const entry of node.entries) collectRootPaths(entry.node, maxDepth, `${path}.${entry.key}`, depth + 1).forEach((p) => paths.add(p));
  } else if (node.kind === 'array') {
    node.children.forEach((child, index) => collectRootPaths(child, maxDepth, `${path}[${index}]`, depth + 1).forEach((p) => paths.add(p)));
  }
  return paths;
}

function JsonTreeRowView({
  row,
  onToggle,
  onCopy,
  tokens,
}: {
  row: JsonTreeRow;
  onToggle: (path: string) => void;
  onCopy: (text: string) => void;
  tokens: SemanticPalette;
}) {
  if (row.kind === 'primitive') {
    return (
      <Pressable
        onLongPress={() => onCopy(row.value)}
        onPress={() => onCopy(row.value)}
        delayLongPress={260}
        accessibilityLabel={`Copy ${row.value}`}
        style={[styles.row, { paddingLeft: rowIndent(row) }]}>
        <Text variant="mono" style={[styles.text, { color: primitiveColor(row.primitive, tokens) }]}>
          {row.value}
        </Text>
      </Pressable>
    );
  }

  if (row.kind === 'container') {
    return (
      <Pressable
        onPress={() => onToggle(row.path)}
        accessibilityRole="button"
        accessibilityState={{ expanded: row.open }}
        style={[styles.row, { paddingLeft: rowIndent(row) }]}>
        <Text variant="mono" style={[styles.text, { color: tokens.textTertiary }]}>
          {row.chevron}
        </Text>
        <Text variant="mono" style={[styles.text, { color: tokens.textSecondary }]}>
          {row.isRoot ? '' : row.nodeKind === 'object' ? '{…}' : '[…]'}
        </Text>
        <Text variant="mono" style={[styles.text, { color: tokens.textTertiary }]}>
          {row.preview}
        </Text>
      </Pressable>
    );
  }

  if (row.kind === 'key') {
    return (
      <View style={[styles.row, { paddingLeft: rowIndent(row) }]}>
        <Text variant="mono" style={[styles.text, { color: tokens.accentWarm }]}>
          {row.key}:
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.braceRow, { paddingLeft: rowIndent(row) }]}>
      <Text variant="mono" style={[styles.text, { color: tokens.textTertiary }]}>
        {row.brace}
      </Text>
    </View>
  );
}

/**
 * Each row owns the nesting depth it renders at; the indentation mirrors the
 * recursive renderer it replaces — a node adds `Spacing.one` plus one
 * `Spacing.three` per level, braces sit one `Spacing.three` inside their
 * container and keys one `Spacing.four`.
 */
function rowIndent(row: JsonTreeRow): number {
  const base = nodeIndent(row.depth);
  if (row.kind === 'key') return base + Spacing.four;
  if (row.kind === 'brace') return base + Spacing.three;
  return base;
}

function nodeIndent(depth: number): number {
  if (depth <= 0) return 0;
  return Spacing.one * depth + (Spacing.three * depth * (depth + 1)) / 2;
}

function primitiveColor(kind: JsonPrimitiveKind, tokens: SemanticPalette): string {
  switch (kind) {
    case 'string':
      return tokens.textPrimary;
    case 'number':
      return tokens.accent;
    case 'boolean':
      return tokens.accentWarm;
    case 'null':
      return tokens.textTertiary;
  }
}

const styles = StyleSheet.create({
  root: {
    width: '100%',
    flexShrink: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    minHeight: 22,
    paddingVertical: Spacing.half,
  },
  braceRow: {
    flexDirection: 'row',
  },
  text: {
    fontFamily: FontFamily.mono,
    fontSize: 12,
    lineHeight: 16,
  },
});
