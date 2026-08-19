import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { FontFamily, Spacing, type SemanticPalette } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { jsonTreeNode, type JsonPrimitiveKind, type JsonTreeNode } from '@/lib/terminal/json-tree';

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
      <NodeRow
        node={root}
        path="root"
        depth={0}
        expanded={expanded}
        onToggle={toggle}
        onCopy={copy}
        tokens={tokens}
        root
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

function NodeRow({
  node,
  path,
  depth,
  expanded,
  onToggle,
  onCopy,
  tokens,
  root = false,
}: {
  node: JsonTreeNode;
  path: string;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onCopy: (text: string) => void;
  tokens: SemanticPalette;
  root?: boolean;
}) {
  const indent = { paddingLeft: root ? 0 : Spacing.one + depth * Spacing.three };

  if (node.kind === 'primitive') {
    return (
      <Pressable
        onLongPress={() => onCopy(node.value)}
        onPress={() => onCopy(node.value)}
        delayLongPress={260}
        accessibilityLabel={`Copy ${node.value}`}
        style={[styles.row, indent]}>
        <Text variant="mono" style={[styles.text, { color: primitiveColor(node.primitive, tokens) }]}>
          {node.value}
        </Text>
      </Pressable>
    );
  }

  const isOpen = expanded.has(path);
  const chevron = node.kind === 'object' ? (isOpen ? '▾' : '▸') : isOpen ? '−' : '+';

  return (
    <View style={indent}>
      <Pressable onPress={() => onToggle(path)} accessibilityRole="button" style={styles.row}>
        <Text variant="mono" style={[styles.text, { color: tokens.textTertiary }]}>
          {chevron}
        </Text>
        <Text variant="mono" style={[styles.text, { color: tokens.textSecondary }]}>
          {root ? '' : node.kind === 'object' ? '{…}' : '[…]'}
        </Text>
        <Text variant="mono" style={[styles.text, { color: tokens.textTertiary }]}>
          {node.preview}
        </Text>
      </Pressable>
      {isOpen ? (
        <View>
          {node.kind === 'object' ? (
            <>
              <View style={[styles.braceRow, { paddingLeft: Spacing.three }]}>
                <Text variant="mono" style={[styles.text, { color: tokens.textTertiary }]}>
                  {'{'}
                </Text>
              </View>
              {node.entries.map((entry) => (
                <View key={entry.key}>
                  <View style={[styles.row, { paddingLeft: Spacing.four }]}>
                    <Text variant="mono" style={[styles.text, { color: tokens.accentWarm }]}>
                      {entry.key}:
                    </Text>
                  </View>
                  <NodeRow
                    node={entry.node}
                    path={`${path}.${entry.key}`}
                    depth={depth + 1}
                    expanded={expanded}
                    onToggle={onToggle}
                    onCopy={onCopy}
                    tokens={tokens}
                  />
                </View>
              ))}
              <View style={[styles.braceRow, { paddingLeft: Spacing.three }]}>
                <Text variant="mono" style={[styles.text, { color: tokens.textTertiary }]}>
                  {'}'}
                </Text>
              </View>
            </>
          ) : (
            <>
              <View style={[styles.braceRow, { paddingLeft: Spacing.three }]}>
                <Text variant="mono" style={[styles.text, { color: tokens.textTertiary }]}>
                  {'['}
                </Text>
              </View>
              {node.children.map((child, index) => (
                <View key={index}>
                  <NodeRow
                    node={child}
                    path={`${path}[${index}]`}
                    depth={depth + 1}
                    expanded={expanded}
                    onToggle={onToggle}
                    onCopy={onCopy}
                    tokens={tokens}
                  />
                </View>
              ))}
              <View style={[styles.braceRow, { paddingLeft: Spacing.three }]}>
                <Text variant="mono" style={[styles.text, { color: tokens.textTertiary }]}>
                  {']'}
                </Text>
              </View>
            </>
          )}
        </View>
      ) : null}
    </View>
  );
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
