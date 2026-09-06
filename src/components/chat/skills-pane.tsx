import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Button, ListRow, Skeleton, Text } from '@/components/ui';
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
  onRetry,
}: {
  skills: Skill[];
  loaded: boolean;
  failed: boolean;
  /** Tap a row to start the same `/<skill-name>` turn typing it dispatches. */
  onInvoke?: (skillName: string) => void;
  /** Re-run the same `skills.list` read the surface effect runs. */
  onRetry?: () => void;
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
          {!loaded && !failed ? (
            <>
              <Skeleton width="90%" height={44} />
              <Skeleton width="76%" height={44} style={styles.gap} />
            </>
          ) : null}
          {copy ? (
            <Text variant="micro" color="secondary">
              {copy}
            </Text>
          ) : null}
          {!loaded && failed && onRetry ? (
            <Button label="Retry" variant="ghost" size="sm" onPress={onRetry} />
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
  gap: { marginTop: Spacing.two },
});
