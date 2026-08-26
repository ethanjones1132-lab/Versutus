import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, ListRow, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import {
  skillsListCopy,
  skillsToggleLabel,
  type Skill,
  type SkillsState,
} from '@/lib/gateway/skills';

export function SkillsPane({
  skills,
  loaded,
  failed,
}: {
  skills: Skill[];
  loaded: boolean;
  failed: boolean;
}) {
  const [open, setOpen] = useState(false);
  const state: SkillsState = { skills, loaded, failed };
  const copy = skillsListCopy(state);

  return (
    <View style={styles.wrap}>
      <Button
        label={skillsToggleLabel(state, open)}
        variant="ghost"
        size="sm"
        onPress={() => setOpen((value) => !value)}
      />
      {open ? (
        <View style={styles.body}>
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
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: Spacing.three, paddingBottom: Spacing.one },
  body: { gap: Spacing.one, paddingTop: Spacing.one },
});
