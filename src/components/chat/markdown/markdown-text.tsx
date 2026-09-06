import * as WebBrowser from 'expo-web-browser';
import { useMemo } from 'react';
import { StyleSheet, Text as RNText, View } from 'react-native';

import { Divider } from '@/components/ui';
import { FontFamily, Palette, Spacing, Typography } from '@/constants/tokens';

import { CodeBlock } from './code-block';
import { markdownBlocksForDisplay, type MdBlock, type MdInline } from './parser';

export type MarkdownTextProps = {
  text: string;
  /** Base text color for body content. */
  color?: string;
  /** Skip markdown parse while tokens are still arriving. */
  streaming?: boolean;
  /** Render body and list text at caption scale instead of body scale. */
  compact?: boolean;
  /**
   * Cap on the OS font-size setting, as `Text` applies per variant
   * (ui/Text.tsx:62). Defaults to 1.4 under `compact` -- the same cap the
   * `caption` variant carries, because past ~1.4x small text stops fitting its
   * container and wraps mid-word. Body-scale markdown stays UNCAPPED by
   * default so large-text users get the size they asked for.
   */
  maxFontSizeMultiplier?: number;
};

function openLink(url: string) {
  void WebBrowser.openBrowserAsync(url).catch(() => undefined);
}

function spanStyle(span: MdInline) {
  return [
    span.bold ? styles.bold : null,
    span.italic ? styles.italic : null,
    span.strike ? styles.strike : null,
    span.code ? styles.inlineCode : null,
    span.link ? styles.link : null,
  ];
}

function InlineSpans({ spans, baseColor, maxFontSizeMultiplier }: { spans: MdInline[]; baseColor: string; maxFontSizeMultiplier?: number }) {
  return (
    <>
      {spans.map((span, index) => (
        <RNText
          key={index}
          maxFontSizeMultiplier={maxFontSizeMultiplier}
          style={[spanStyle(span), span.link || span.code ? null : { color: baseColor }]}
          onPress={span.link ? () => openLink(span.link!) : undefined}
          accessibilityRole={span.link ? 'link' : undefined}>
          {span.text}
        </RNText>
      ))}
    </>
  );
}

const HEADING_SIZES: Record<1 | 2 | 3 | 4, { fontSize: number; lineHeight: number }> = {
  1: { fontSize: Typography.title.fontSize, lineHeight: Typography.title.lineHeight },
  2: { fontSize: Typography.headline.fontSize, lineHeight: Typography.headline.lineHeight },
  3: { fontSize: Typography.body.fontSize, lineHeight: Typography.body.lineHeight },
  4: { fontSize: Typography.caption.fontSize, lineHeight: Typography.caption.lineHeight },
};

function BlockView({ block, baseColor, compact, maxFontSizeMultiplier }: { block: MdBlock; baseColor: string; compact: boolean; maxFontSizeMultiplier?: number }) {
  switch (block.type) {
    case 'heading':
      return (
        <RNText maxFontSizeMultiplier={maxFontSizeMultiplier} style={[styles.heading, HEADING_SIZES[block.level], { color: Palette.textPrimary }]}>
          <InlineSpans spans={block.spans} baseColor={Palette.textPrimary} maxFontSizeMultiplier={maxFontSizeMultiplier} />
        </RNText>
      );
    case 'code':
      return <CodeBlock code={block.code} language={block.language} />;
    case 'quote':
      return (
        <View style={[styles.quote, { borderLeftColor: Palette.accentWarmMuted }]}>
          <RNText maxFontSizeMultiplier={maxFontSizeMultiplier} style={[compact ? styles.bodyCompact : styles.body, { color: Palette.textSecondary, fontStyle: 'italic' }]}>
            <InlineSpans spans={block.spans} baseColor={Palette.textSecondary} maxFontSizeMultiplier={maxFontSizeMultiplier} />
          </RNText>
        </View>
      );
    case 'list':
      return (
        <View style={styles.list}>
          {block.items.map((item, index) => (
            <View key={index} style={styles.listItem}>
              <RNText maxFontSizeMultiplier={maxFontSizeMultiplier} style={[compact ? styles.listMarkerCompact : styles.listMarker, { color: Palette.accentWarm }]}>
                {block.ordered ? `${index + 1}.` : '•'}
              </RNText>
              <RNText maxFontSizeMultiplier={maxFontSizeMultiplier} style={[compact ? styles.bodyCompact : styles.body, styles.listText, { color: baseColor }]}>
                <InlineSpans spans={item} baseColor={baseColor} maxFontSizeMultiplier={maxFontSizeMultiplier} />
              </RNText>
            </View>
          ))}
        </View>
      );
    case 'hr':
      return <Divider style={styles.hr} />;
    case 'paragraph':
    default:
      return (
        <RNText maxFontSizeMultiplier={maxFontSizeMultiplier} style={[compact ? styles.bodyCompact : styles.body, { color: baseColor }]}>
          <InlineSpans spans={block.spans} baseColor={baseColor} maxFontSizeMultiplier={maxFontSizeMultiplier} />
        </RNText>
      );
  }
}

/** Themed markdown renderer for agent chat messages. */
export function MarkdownText({
  text,
  color = Palette.textPrimary,
  streaming = false,
  compact = false,
  maxFontSizeMultiplier,
}: MarkdownTextProps) {
  const blocks = useMemo(() => markdownBlocksForDisplay(text, streaming), [text, streaming]);
  // Compact rows replaced a `<Text variant="caption">`, which carried a 1.4 cap
  // (ui/Text.tsx:40). Without this the command bubble is uncapped and overflows
  // at large system font sizes. `undefined` at body scale is deliberate: RNText
  // keeps its default, exactly as before this prop existed.
  const fontCap = maxFontSizeMultiplier ?? (compact ? 1.4 : undefined);

  return (
    <View style={styles.root}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} baseColor={color} compact={compact} maxFontSizeMultiplier={fontCap} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: Spacing.two,
  },
  body: {
    fontFamily: FontFamily.sans,
    fontSize: 16,
    lineHeight: 24,
  },
  bodyCompact: {
    fontFamily: FontFamily.sans,
    fontSize: 13,
    lineHeight: 18,
  },
  heading: {
    fontFamily: FontFamily.sansSemiBold,
    marginTop: Spacing.one,
  },
  bold: {
    fontFamily: FontFamily.sansBold,
  },
  italic: {
    fontStyle: 'italic',
  },
  strike: {
    textDecorationLine: 'line-through',
  },
  inlineCode: {
    fontFamily: FontFamily.mono,
    fontSize: 13,
    backgroundColor: Palette.backgroundInset,
    color: Palette.accentWarm,
  },
  link: {
    color: Palette.accentWarm,
    textDecorationLine: 'underline',
  },
  quote: {
    borderLeftWidth: 2,
    paddingLeft: Spacing.three - 4,
    paddingVertical: 2,
  },
  list: {
    gap: Spacing.one,
  },
  listItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  listMarker: {
    fontFamily: FontFamily.sansSemiBold,
    fontSize: 14,
    lineHeight: 24,
    minWidth: 16,
  },
  listMarkerCompact: {
    fontFamily: FontFamily.sansSemiBold,
    fontSize: 12,
    lineHeight: 18,
    minWidth: 14,
  },
  listText: {
    flex: 1,
  },
  hr: {
    marginVertical: Spacing.two,
  },
});
