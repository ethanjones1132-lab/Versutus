import { useCallback, useMemo, useRef } from 'react';
import { FlatList, StyleSheet, Text as RNText, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

import { FontFamily, Spacing, type SemanticPalette } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { parseAnsiText, ansiPlainText, type AnsiColor } from '@/lib/terminal/ansi';
import { isPromptLine, type TerminalLine } from '@/lib/terminal/output';

export type TerminalOutputProps = {
  lines: TerminalLine[];
  placeholder?: string;
  onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
};

// ANSI colour numbers mapped onto the Versutus palette. Bright variants are
// the same hue lifted; this keeps a real shell's colours inside the luxury
// scheme instead of raw terminal neon.
export function ansiPalette(tokens: SemanticPalette): Record<AnsiColor, string> {
  return {
    black: tokens.textTertiary,
    red: tokens.statusDisconnected,
    green: tokens.statusConnected,
    yellow: tokens.accentWarm,
    blue: '#96AFE2',
    magenta: '#D8A8DE',
    cyan: '#92D0CC',
    white: tokens.textPrimary,
    brightBlack: tokens.textTertiary,
    brightRed: '#F3A0A0',
    brightGreen: '#93E8C0',
    brightYellow: '#F9E6B4',
    brightBlue: '#B2C6F2',
    brightMagenta: '#E9C8EE',
    brightCyan: '#B4E6E2',
    brightWhite: '#FFFFFF',
    default: tokens.textPrimary,
  };
}

/** Virtualized terminal pane. Output is capped and auto-scrolls to the tail. */
export function TerminalOutput({
  lines,
  placeholder = 'Terminal output will appear here…',
  onScroll,
}: TerminalOutputProps) {
  const tokens = useTokens();
  const listRef = useRef<FlatList<TerminalLine>>(null);
  const palette = useMemo(() => ansiPalette(tokens), [tokens]);

  const renderLine = useCallback(
    ({ item }: { item: TerminalLine }) => {
      const prompt = isPromptLine(item.text);
      return (
        <View style={styles.lineWrap}>
          <View style={[styles.gutter, { backgroundColor: prompt ? tokens.accentWarm : tokens.accentWarmMuted }]} />
          <View style={styles.line}>
            <TextLine text={item.text || ' '} tokens={tokens} palette={palette} prompt={prompt} />
          </View>
        </View>
      );
    },
    [palette, tokens],
  );

  if (lines.length === 0) {
    return (
      <View style={styles.empty}>
        <TextLine text={placeholder} tokens={tokens} palette={palette} prompt={false} muted />
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
      onScroll={onScroll}
      scrollEventThrottle={16}
      showsVerticalScrollIndicator
      removeClippedSubviews
    />
  );
}

function TextLine({
  text,
  tokens,
  palette,
  prompt,
  muted = false,
}: {
  text: string;
  tokens: SemanticPalette;
  palette: Record<AnsiColor, string>;
  prompt: boolean;
  muted?: boolean;
}) {
  const label = useMemo(() => ansiPlainText(text), [text]);
  const spans = useMemo(() => parseAnsiText(text), [text]);
  const baseColor = muted ? tokens.textTertiary : tokens.textPrimary;

  return (
    <RNText accessibilityLabel={label} style={[styles.text, muted && { color: tokens.textTertiary }]}>
      {spans.map((span, index) => {
        const color = prompt && span.fg === 'default' ? tokens.accentWarm : palette[span.fg] ?? baseColor;
        return (
          <RNText
            key={`${index}-${span.text.length}`}
            style={[
              styles.text,
              { color },
              span.bold && styles.bold,
              span.dim && styles.dim,
              prompt && span.fg === 'default' && styles.promptMark,
            ]}>
            {span.text}
          </RNText>
        );
      })}
    </RNText>
  );
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
  text: {
    fontFamily: FontFamily.mono,
    fontSize: 12,
    lineHeight: 18,
  },
  bold: {
    fontFamily: FontFamily.monoBold,
  },
  dim: {
    opacity: 0.55,
  },
  promptMark: {
    fontWeight: '700' as const,
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    padding: Spacing.three,
  },
});
