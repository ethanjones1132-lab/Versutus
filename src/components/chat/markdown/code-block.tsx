import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text as RNText, View } from 'react-native';

import { Icon, PressableScale, Text } from '@/components/ui';
import { FontFamily, Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { haptics } from '@/lib/haptics';

export type CodeBlockProps = {
  code: string;
  language?: string;
};

/** Fenced code block: mono, horizontally scrollable, with a copy action. */
export function CodeBlock({ code, language }: CodeBlockProps) {
  const tokens = useTokens();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await Clipboard.setStringAsync(code);
    await haptics.success();
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <View
      style={[
        styles.block,
        { backgroundColor: tokens.backgroundInset, borderColor: tokens.borderSubtle },
      ]}>
      <View style={[styles.header, { borderBottomColor: tokens.borderSubtle }]}>
        <Text variant="micro" color="tertiary" style={styles.language}>
          {language ?? 'code'}
        </Text>
        <PressableScale
          onPress={() => void handleCopy()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={copied ? 'Copied' : 'Copy code'}
          style={styles.copyButton}>
          <Icon
            name={
              copied
                ? { ios: 'checkmark', android: 'check', web: 'check' }
                : { ios: 'doc.on.doc', android: 'content_copy', web: 'content_copy' }
            }
            size={12}
            color={copied ? 'statusConnected' : 'textTertiary'}
          />
          <Text variant="micro" color={copied ? 'statusConnected' : 'tertiary'}>
            {copied ? 'Copied' : 'Copy'}
          </Text>
        </PressableScale>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.scroll}>
        <RNText style={[styles.code, { color: tokens.textSecondary }]} selectable>
          {code}
        </RNText>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  language: {
    textTransform: 'uppercase',
  },
  copyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingVertical: 2,
    paddingHorizontal: Spacing.one,
  },
  scroll: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
  },
  code: {
    fontFamily: FontFamily.mono,
    fontSize: 12,
    lineHeight: 17,
  },
});
