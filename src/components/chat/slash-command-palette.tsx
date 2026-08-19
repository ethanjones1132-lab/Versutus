import * as Haptics from 'expo-haptics';
import { useMemo, useState } from 'react';
import { SectionList, StyleSheet, View } from 'react-native';

import { BaseSheet, EmptyState, Icon, PressableScale, Text, TextField } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import type { SlashCommandSuggestion } from '@/lib/gateway/slash-commands';
import { filterPaletteSuggestions, groupSuggestionsByFamily } from '@/lib/gateway/slash-palette';

export type SlashCommandPaletteProps = {
  visible: boolean;
  /** The full, uncapped command surface. */
  commands: readonly SlashCommandSuggestion[];
  /** Seeds the search field when the palette opens, e.g. from the composer draft. */
  initialQuery?: string;
  onClose: () => void;
  onSelect: (value: string) => void;
};

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
  const [query, setQuery] = useState(initialQuery);

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
          style={styles.list}
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
                <Text variant="caption" color="secondary" numberOfLines={2}>
                  {item.description}
                </Text>
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
