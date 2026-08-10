import { useCallback, useRef } from 'react';
import { FlatList, StyleSheet, Text as RNText, View } from 'react-native';

import { FontFamily, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import type { TerminalLine } from '@/lib/terminal/output';

export type TerminalOutputProps = {
  lines: TerminalLine[];
  placeholder?: string;
};

/** Virtualized terminal pane. Output is capped and auto-scrolls to the tail. */
export function TerminalOutput({ lines, placeholder = 'Terminal output will appear here…' }: TerminalOutputProps) {
  const tokens = useTokens();
  const listRef = useRef<FlatList<TerminalLine>>(null);

  const renderLine = useCallback(
    ({ item }: { item: TerminalLine }) => (
      <View style={styles.lineWrap}>
        <View style={[styles.gutter, { backgroundColor: tokens.accentWarmMuted }]} />
        <View style={styles.line}>
          <TextLine text={item.text || ' '} color={tokens.textPrimary} />
        </View>
      </View>
    ),
    [tokens.accentWarmMuted, tokens.textPrimary],
  );

  if (lines.length === 0) {
    return (
      <View style={styles.empty}>
        <TextLine text={placeholder} color={tokens.textTertiary} />
      </View>
    );
  }

  return (
    <FlatList
      ref={listRef}
      data={lines}
      keyExtractor={(item) => String(item.id)}
      renderItem={renderLine}
      contentContainerStyle={styles.content}
      onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
      showsVerticalScrollIndicator
      removeClippedSubviews
    />
  );
}

function TextLine({ text, color }: { text: string; color: string }) {
  return <View accessibilityLabel={text} style={styles.textLine}><RNMono text={text} color={color} /></View>;
}

// Kept local to avoid making terminal output depend on the higher-level Text
// component, which intentionally applies body typography and nested spacing.
function RNMono({ text, color }: { text: string; color: string }) {
  return <RNText style={[styles.text, { color }]}>{text}</RNText>;
}

const styles = StyleSheet.create({
  content: {
    padding: Spacing.two,
    paddingBottom: Spacing.three,
  },
  lineWrap: {
    flexDirection: 'row',
    minHeight: 18,
  },
  gutter: {
    width: 2,
    marginRight: Spacing.two,
    opacity: 0.4,
  },
  line: {
    flex: 1,
  },
  textLine: {
    minHeight: 18,
  },
  text: {
    fontFamily: FontFamily.mono,
    fontSize: 12,
    lineHeight: 18,
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    padding: Spacing.three,
  },
});
