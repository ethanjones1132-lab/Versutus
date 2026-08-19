import { SymbolView } from 'expo-symbols';
import type React from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';

import { GlassSurface } from './GlassSurface';
import { PressableScale } from './PressableScale';
import { Text } from './Text';
import type { ScreenHeaderProps } from './types';
import { WebSymbol } from './WebSymbol';

export function ScreenHeader({
  title,
  subtitle,
  onTrailingPress,
  trailingIcon = { ios: 'gearshape.fill' as const, android: 'settings', web: 'gearshape.fill' },
  trailing,
  style,
}: ScreenHeaderProps) {
  const tokens = useTokens();

  return (
    <View style={[styles.header, style]}>
      {title ? (
        <View style={styles.titles}>
          <Text variant="headline">{title}</Text>
          {subtitle ? (
            <Text variant="caption" color="secondary">
              {subtitle}
            </Text>
          ) : null}
        </View>
      ) : (
        <View style={styles.titles} />
      )}

      {trailing ??
        (onTrailingPress ? (
          <PressableScale onPress={onTrailingPress} hitSlop={12}>
            <GlassSurface variant="chip" padding={0} style={styles.trailing}>
              {Platform.OS === 'web' ? (
                <WebSymbol name={trailingIcon.web} size={22} color={tokens.accentWarm} />
              ) : (
                <SymbolView
                  name={
                    {
                      ios: trailingIcon.ios,
                      android: trailingIcon.android,
                      web: trailingIcon.web,
                    } as React.ComponentProps<typeof SymbolView>['name']
                  }
                  size={22}
                  tintColor={tokens.accentWarm}
                  weight="medium"
                />
              )}
            </GlassSurface>
          </PressableScale>
        ) : null)}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.three,
    gap: Spacing.three,
  },
  titles: {
    flex: 1,
    gap: Spacing.one,
  },
  trailing: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
