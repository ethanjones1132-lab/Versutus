import { SymbolView } from 'expo-symbols';
import type React from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import type { SFSymbol } from 'sf-symbols-typescript';

import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';

import { GlassSurface } from './GlassSurface';
import { PressableScale } from './PressableScale';
import { Text } from './Text';
import { WebSymbol } from './WebSymbol';

export type AppHeaderVariant = 'page' | 'thread' | 'compact';

export type AppHeaderProps = {
  /**
   * The design table's three header shapes: a page's large serif title, a
   * thread's one-row identity (crest + title + subtitle), or a compact bar for
   * a secondary route. One component owns the title area, so a screen must
   * never also set a native stack title for the same word.
   */
  variant?: AppHeaderVariant;
  title?: string;
  /** One quiet line under the title: connection, cost, room, status. */
  status?: React.ReactNode;
  /** Thread only: the identity's second line (model, room, connection). */
  subtitle?: string;
  /** The menu, back or close control. */
  leading?: React.ReactNode;
  /** A trailing control already built by the screen. Wins over `onTrailingPress`. */
  trailing?: React.ReactNode;
  /** Builds the standard bordered icon control at the trailing edge. */
  onTrailingPress?: () => void;
  trailingIcon?: { ios: SFSymbol; android: string; web: string };
  trailingLabel?: string;
  /**
   * True once content has scrolled under the bar — the only state that paints
   * a surface. At rest the header is flat on the stage, with the hairline
   * already there (transparent) so gaining the surface never nudges the row.
   */
  scrolled?: boolean;
  /** Keeps the bar but omits the title (the roster's greeting owns the name). */
  titleHidden?: boolean;
  /** Horizontal inset so the title lines up with the screen's content. */
  inset?: number;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * The one header every route draws: `page` (serif title, status, controls),
 * `thread` (one row of identity) or `compact` (one row, no subtitle). It is
 * flat at rest and gains the smoked-glass surface only while content passes
 * beneath it, so the app has one title voice instead of a header per screen.
 */
export function AppHeader({
  variant = 'page',
  title,
  status,
  subtitle,
  leading,
  trailing,
  onTrailingPress,
  trailingIcon = { ios: 'gearshape.fill' as const, android: 'settings', web: 'gearshape.fill' },
  trailingLabel = 'Open settings',
  scrolled = false,
  titleHidden = false,
  inset,
  testID,
  style,
}: AppHeaderProps) {
  const tokens = useTokens();
  const hasTitle = !titleHidden && (title ?? '').trim().length > 0;
  const surface = scrolled
    ? { backgroundColor: tokens.stageGlass, borderBottomColor: tokens.border }
    : null;

  const trailingControl =
    trailing ??
    (onTrailingPress ? (
      <PressableScale
        onPress={onTrailingPress}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel={trailingLabel}>
        <GlassSurface variant="inset" padding={0} style={styles.trailingIcon}>
          {Platform.OS === 'web' ? (
            <WebSymbol name={trailingIcon.web} size={22} color={tokens.accent} />
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
              tintColor={tokens.accent}
              weight="medium"
            />
          )}
        </GlassSurface>
      </PressableScale>
    ) : null);

  const titleBlock = hasTitle ? (
    <View accessible accessibilityRole="header">
      <Text variant={variant === 'page' ? 'display' : 'headline'} numberOfLines={1}>
        {title}
      </Text>
    </View>
  ) : null;

  if (variant === 'page') {
    return (
      <View
        testID={testID ?? 'app-header-page'}
        style={[
          styles.bar,
          styles.page,
          inset === undefined ? null : { paddingHorizontal: inset },
          surface,
          style,
        ]}>
        {leading || trailingControl ? (
          <View style={styles.controls}>
            <View style={styles.side}>{leading}</View>
            <View style={[styles.side, styles.trailingSide]}>{trailingControl}</View>
          </View>
        ) : null}
        <View style={styles.titles}>
          {titleBlock}
          {status ? <View style={styles.status}>{status}</View> : null}
        </View>
      </View>
    );
  }

  return (
    <View
      testID={testID ?? `app-header-${variant}`}
      style={[
        styles.bar,
        styles.row,
        inset === undefined ? null : { paddingHorizontal: inset },
        surface,
        style,
      ]}>
      {leading}
      <View style={styles.rowTitles}>
        {titleBlock}
        {subtitle ? (
          <Text variant="caption" color="secondary" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
        {status ? <View style={styles.status}>{status}</View> : null}
      </View>
      {trailingControl}
    </View>
  );
}

const styles = StyleSheet.create({
  // The hairline is always present (transparent at rest), so switching to the
  // scrolled surface cannot move the row by half a pixel.
  bar: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'transparent',
  },
  page: {
    gap: Spacing.three,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.three,
    paddingHorizontal: Spacing.four,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    minHeight: 56,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 40,
    marginHorizontal: -Spacing.two,
  },
  side: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  trailingSide: {
    justifyContent: 'flex-end',
  },
  titles: {
    gap: Spacing.one,
  },
  rowTitles: {
    flex: 1,
    gap: Spacing.one,
  },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  trailingIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.full,
  },
});
