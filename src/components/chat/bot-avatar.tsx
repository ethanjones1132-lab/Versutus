import { StyleSheet, View } from 'react-native';

import { GlassSurface } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { botAvatarFromId } from '@/lib/bot-avatar';

type BotAvatarProps = {
  botId: string;
  /** Outer chip size; matches ListRow's icon halo. */
  size?: number;
};

/**
 * A bot's generated identity mark: a geometric glyph whose shape and accent
 * are derived deterministically from the bot id (see src/lib/bot-avatar.ts).
 * Rendered inside the same glass chip as ListRow's icon halo so roster rows
 * keep one visual rhythm.
 */
export function BotAvatar({ botId, size = 34 }: BotAvatarProps) {
  const { shape, accent } = botAvatarFromId(botId);
  const glyph = Math.round(size * 0.42);

  return (
    <GlassSurface
      variant="chip"
      radius={Radius.full}
      padding={0}
      style={[styles.halo, { width: size, height: size }]}>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          styles.glyph,
          shape === 'circle' && { borderRadius: Radius.full },
          shape === 'square' && { borderRadius: Radius.xs },
          shape === 'diamond' && { borderRadius: Radius.xs, transform: [{ rotate: '45deg' }] },
          { width: glyph, height: glyph, backgroundColor: accent },
        ]}
      />
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  // Mirrors ListRow's statusDot inset so custom leading elements align with
  // the built-in glyph column.
  halo: {
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: Spacing.two,
  },
  glyph: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
