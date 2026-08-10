import * as WebBrowser from 'expo-web-browser';
import { useMemo } from 'react';
import { StyleSheet, Text as RNText, View } from 'react-native';

import { Divider } from '@/components/ui';
import { FontFamily, Palette, Spacing } from '@/constants/tokens';

import { CodeBlock } from './code-block';
import { parseMarkdown, type MdBlock, type MdInline } from './parser';

export type MarkdownTextProps = {
  text: string;
  /** Base text color for body content. */
  color?: string;
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

function InlineSpans({ spans, baseColor }: { spans: MdInline[]; baseColor: string }) {
  return (
    <>
      {spans.map((span, index) => (
        <RNText
          key={index}
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
  1: { fontSize: 22, lineHeight: 28 },
  2: { fontSize: 19, lineHeight: 25 },
  3: { fontSize: 17, lineHeight: 23 },
  4: { fontSize: 16, lineHeight: 22 },
};

function BlockView({ block, baseColor }: { block: MdBlock; baseColor: string }) {
  switch (block.type) {
    case 'heading':
      return (
        <RNText style={[styles.heading, HEADING_SIZES[block.level], { color: Palette.textPrimary }]}>
          <InlineSpans spans={block.spans} baseColor={Palette.textPrimary} />
        </RNText>
      );
    case 'code':
      return <CodeBlock code={block.code} language={block.language} />;
    case 'quote':
      return (
        <View style={[styles.quote, { borderLeftColor: Palette.accentWarmMuted }]}>
          <RNText style={[styles.body, { color: Palette.textSecondary, fontStyle: 'italic' }]}>
            <InlineSpans spans={block.spans} baseColor={Palette.textSecondary} />
          </RNText>
        </View>
      );
    case 'list':
      return (
        <View style={styles.list}>
          {block.items.map((item, index) => (
            <View key={index} style={styles.listItem}>
              <RNText style={[styles.listMarker, { color: Palette.accentWarm }]}>
                {block.ordered ? `${index + 1}.` : '•'}
              </RNText>
              <RNText style={[styles.body, styles.listText, { color: baseColor }]}>
                <InlineSpans spans={item} baseColor={baseColor} />
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
        <RNText style={[styles.body, { color: baseColor }]}>
          <InlineSpans spans={block.spans} baseColor={baseColor} />
        </RNText>
      );
  }
}

/** Themed markdown renderer for agent chat messages. */
export function MarkdownText({ text, color = Palette.textPrimary }: MarkdownTextProps) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);

  return (
    <View style={styles.root}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} baseColor={color} />
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
  listText: {
    flex: 1,
  },
  hr: {
    marginVertical: Spacing.two,
  },
});
