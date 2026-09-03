import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Button, ListRow, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import {
  SKILLS_PANE_MAX_HEIGHT,
  skillsListCopy,
  skillsToggleLabel,
  type Skill,
  type SkillsState,
} from '@/lib/gateway/skills';

export function SkillsPane({
  skills,
  loaded,
  failed,
  onInvoke,
}: {
  skills: Skill[];
  loaded: boolean;
  failed: boolean;
  /** Tap a row to start the same `/<skill-name>` turn typing it dispatches. */
  onInvoke?: (skillName: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const state: SkillsState = { skills, loaded, failed };
  const copy = skillsListCopy(state);

  return (
    <View style={styles.wrap}>
      <Button
        label={skillsToggleLabel(state, open)}
        variant="ghost"
        size="md"
        onPress={() => setOpen((value) => !value)}
      />
      {open ? (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.body}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {copy ? (
            <Text variant="micro" color="secondary">
              {copy}
            </Text>
          ) : null}
          {skills.map((skill) => (
            <ListRow
              key={skill.name}
              title={skill.name}
              subtitle={skill.description || undefined}
              onPress={onInvoke ? () => onInvoke(skill.name) : undefined}
            />
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: Spacing.three, paddingBottom: Spacing.one },
  scroll: { maxHeight: SKILLS_PANE_MAX_HEIGHT },
  body: { gap: Spacing.one, paddingTop: Spacing.one },
});
