import { memo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Button, ErrorCard, ListRow, Skeleton, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import {
  SKILLS_PANE_MAX_HEIGHT,
  skillsListCopy,
  skillsToggleLabel,
  type Skill,
  type SkillsState,
} from '@/lib/gateway/skills';

/** Bot Chat skills pane — wrapped in `memo` so a chat-screen tick that does not
 * change `skills`, `loaded`, `failed`, `error`, `onInvoke`, or `onRetry` does
 * not re-render this subtree (the `open` `useState`, the fresh `state`/`copy`
 * allocations, and the `<ListRow>` rows all stay still). */
function SkillsPaneImpl({
  skills,
  loaded,
  failed,
  error,
  onInvoke,
  onRetry,
}: {
  skills: Skill[];
  loaded: boolean;
  failed: boolean;
  /** Kept cause of the last failed read, when the refusal carried one. */
  error?: string;
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
        expanded={open}
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
          {!loaded && failed ? (
            <ErrorCard
              cause={error ?? 'Skills could not be read.'}
              affected="Skills on this Bot"
              next="Retry, or check the Gate log for the failing call."
              onRetry={onRetry}
            />
          ) : null}
          {loaded && copy ? (
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

export const SkillsPane = memo(SkillsPaneImpl);
SkillsPane.displayName = 'SkillsPane';

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: Spacing.three, paddingBottom: Spacing.one },
  scroll: { maxHeight: SKILLS_PANE_MAX_HEIGHT },
  body: { gap: Spacing.one, paddingTop: Spacing.one },
  gap: { marginTop: Spacing.two },
});
