import { StyleSheet, View } from 'react-native';

import { VersutusMark } from '@/components/brand/versutus-mark';
import { Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';

type VersutusLogotypeProps = {
  variant?: 'hero' | 'compact';
  tagline?: string;
  align?: 'center' | 'start';
  layout?: 'vertical' | 'horizontal';
  showMark?: boolean;
};

export function VersutusLogotype({
  variant = 'hero',
  tagline,
  align = 'center',
  layout,
  showMark = true,
}: VersutusLogotypeProps) {
  const isHero = variant === 'hero';
  const markSize = isHero ? 52 : 36;
  const resolvedLayout = layout ?? (isHero ? 'vertical' : 'horizontal');

  return (
    <View
      style={[
        styles.root,
        resolvedLayout === 'horizontal' && styles.horizontal,
        align === 'center' && styles.centered,
      ]}>
      {showMark ? <VersutusMark size={markSize} showBackground={isHero} /> : null}
      <View style={[styles.textBlock, align === 'center' && styles.textCentered]}>
        <Text variant={isHero ? 'display' : 'title'} style={isHero ? styles.wordmark : undefined}>
          Versutus
        </Text>
        {tagline ? (
          <Text color="secondary" style={styles.tagline}>
            {tagline}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: Spacing.three,
    alignItems: 'center',
  },
  horizontal: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  centered: {
    alignItems: 'center',
  },
  textBlock: {
    gap: Spacing.two,
  },
  textCentered: {
    alignItems: 'center',
  },
  wordmark: {
    letterSpacing: 1,
  },
  tagline: {
    lineHeight: 22,
    textAlign: 'center',
    maxWidth: 320,
  },
});