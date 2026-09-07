import * as Haptics from 'expo-haptics';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { Keyboard, SectionList, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BaseSheet, EmptyState, Icon, PressableScale, Text, TextField } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import type { SlashCommandSuggestion } from '@/lib/gateway/slash-commands';
import { CHIP_HIT_SLOP } from '@/lib/motion/chip-hit-slop';
import { filterPaletteSuggestions, groupSuggestionsByFamily } from '@/lib/gateway/slash-palette';
import { paletteListMaxHeight } from '@/lib/motion/slash-palette-height';

export type SlashCommandPaletteProps = {
  visible: boolean;
  /** The full, uncapped command surface. */
  commands: readonly SlashCommandSuggestion[];
  /** Seeds the search field when the palette opens, e.g. from the composer draft. */
  initialQuery?: string;
  onClose: () => void;
  onSelect: (value: string) => void;
};

function subscribeKeyboardHeight(onChange: () => void) {
  const show = Keyboard.addListener('keyboardDidShow', onChange);
  const hide = Keyboard.addListener('keyboardDidHide', onChange);
  const frame = Keyboard.addListener('keyboardDidChangeFrame', onChange);
  return () => {
    show.remove();
    hide.remove();
    frame.remove();
  };
}

function getKeyboardHeight(): number {
  const height = Keyboard.metrics()?.height;
  return typeof height === 'number' && Number.isFinite(height) ? height : 0;
}

/**
 * Browsable view of the whole slash-command surface.
 *
 * The composer strip only shows the top matches for what is already typed,
 * which is useless for discovery — you cannot find a command you do not know
 * the name of. This groups every command by family so it can be read.
 */
export function SlashCommandPalette({
  visible,
  commands,
  initialQuery = '',
  onClose,
  onSelect,
}: SlashCommandPaletteProps) {
  const tokens = useTokens();
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const keyboardHeight = useSyncExternalStore(
    subscribeKeyboardHeight,
    getKeyboardHeight,
    () => 0,
  );
  const listMaxHeight = paletteListMaxHeight({
    windowHeight,
    insetTop: insets.top,
    insetBottom: insets.bottom,
    keyboardHeight,
  });
  const [query, setQuery] = useState(initialQuery);
  // Default collapsed keeps the list dense; a command's full description is one
  // tap away. Keyed by command value so each row remembers its own expansion.
  const [expandedDescs, setExpandedDescs] = useState<Record<string, boolean>>({});

  // Re-seed on each open so the palette reflects whatever the composer holds
  // now, without clobbering what the user types once it is already open.
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) setQuery(initialQuery);
  }

  const sections = useMemo(() => {
    const filtered = filterPaletteSuggestions(commands, query);
    return groupSuggestionsByFamily(filtered).map((group) => ({
      title: group.family,
      data: group.items,
    }));
  }, [commands, query]);

  const total = sections.reduce((sum, section) => sum + section.data.length, 0);

  if (!visible) return null;

  return (
    <BaseSheet
      visible={visible}
      eyebrow="COMMANDS"
      title="Command palette"
      onClose={onClose}
      closeLabel="Done"
      position="bottom"
    >
      <TextField
        value={query}
        onChangeText={setQuery}
        placeholder="Search commands"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={styles.search}
      />

      {total === 0 ? (
        <EmptyState
          icon={{ ios: 'magnifyingglass', android: 'search', web: 'search' }}
          title="No matches"
          description={`No command matches “${query.trim()}”.`}
          actionLabel="Clear search"
          onAction={() => setQuery('')}
        />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.value}
          style={[styles.list, { maxHeight: listMaxHeight }]}
          stickySectionHeadersEnabled={false}
          keyboardShouldPersistTaps="handled"
          removeClippedSubviews
          renderSectionHeader={({ section }) => (
            <Text variant="micro" color="tertiary" style={styles.sectionHeader}>
              {section.title.toUpperCase()}
            </Text>
          )}
          renderItem={({ item }) => {
            const danger = item.danger === 'write' || item.danger === 'destructive';
            const descExpanded = expandedDescs[item.value] ?? false;
            return (
              <PressableScale
                style={[
                  styles.row,
                  {
                    backgroundColor: tokens.backgroundInset,
                    borderColor: danger ? tokens.accentWarmMuted : tokens.borderSubtle,
                    opacity: item.unavailable ? 0.55 : 1,
                  },
                ]}
                disabled={item.unavailable}
                accessibilityRole="button"
                accessibilityLabel={`Command ${item.label}`}
                accessibilityState={{ disabled: item.unavailable }}
                onPress={async () => {
                  await Haptics.selectionAsync();
                  onSelect(item.value);
                  onClose();
                }}
              >
                <View style={styles.rowHead}>
                  <Text variant="mono" numberOfLines={1} style={styles.rowLabel}>
                    {item.label}
                  </Text>
                  {item.danger === 'destructive' ? (
                    <Icon
                      name={{ ios: 'exclamationmark.triangle.fill', android: 'warning', web: 'warning' }}
                      size={11}
                      color="statusDisconnected"
                    />
                  ) : item.danger === 'write' ? (
                    <Icon
                      name={{ ios: 'exclamationmark.triangle', android: 'warning', web: 'warning' }}
                      size={11}
                      color="statusConnecting"
                    />
                  ) : null}
                </View>
                <PressableScale
                  onPress={(event) => {
                    // The row itself is a press target that selects the command;
                    // swallow the tap so expanding the description does not also
                    // fire onSelect and close the palette.
                    event.stopPropagation();
                    setExpandedDescs((prev) => ({ ...prev, [item.value]: !prev[item.value] }));
                  }}
                  hitSlop={CHIP_HIT_SLOP}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: descExpanded }}
                  accessibilityLabel={descExpanded ? 'Collapse command description' : 'Expand command description'}>
                  <Text variant="caption" color="secondary" numberOfLines={descExpanded ? undefined : 2}>
                    {item.description}
                  </Text>
                </PressableScale>
                {item.unavailable ? (
                  <Text variant="micro" color="tertiary">
                    Not available on this gateway
                  </Text>
                ) : null}
              </PressableScale>
            );
          }}
        />
      )}
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  search: { marginBottom: Spacing.two },
  list: { maxHeight: 380 },
  sectionHeader: {
    marginTop: Spacing.two,
    marginBottom: Spacing.one,
  },
  row: {
    gap: Spacing.half,
    padding: Spacing.two,
    marginBottom: Spacing.one,
    borderRadius: Radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  rowHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  rowLabel: { flexShrink: 1 },
});
