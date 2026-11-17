import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { BaseSheet, Button, Chip, ListRow, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { ROUTINE_TEMPLATES, applyRoutineTemplate } from '@/lib/gateway/routine-templates';
import { applyRoutineCreate, describeRoutineError, type RoutineDraft } from '@/lib/gateway/routines';
import { SchedulePicker } from './schedule-picker';

import { routineTargets, type RoutineCreateScope, type RoutineTarget } from '@/lib/routines/targets';

export { routineTargets, type RoutineCreateScope, type RoutineTarget };

export function NewRoutineSheet({
  visible,
  targets,
  initialBackendId,
  initialBotId,
  onClose,
  onCreate,
}: {
  visible: boolean;
  targets: RoutineTarget[];
  initialBackendId?: string;
  initialBotId?: string;
  onClose: () => void;
  onCreate: (input: RoutineDraft, scope: RoutineCreateScope) => Promise<unknown>;
}) {
  const defaultTarget = useMemo(
    () => targets.find((target) =>
      target.kind === 'Bot' &&
      target.scope.botId === initialBotId &&
      (!initialBackendId || target.scope.backendId === initialBackendId),
    ) ??
      targets.find((target) => target.kind === 'Backend' && target.scope.backendId === initialBackendId) ??
      targets[0],
    [initialBackendId, initialBotId, targets],
  );
  const [targetKey, setTargetKey] = useState(defaultTarget?.key ?? '');
  const [draft, setDraft] = useState<RoutineDraft>({ title: '', prompt: '', schedule: '0 9 * * *' });
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const target = targets.find((item) => item.key === targetKey) ?? defaultTarget;

  const submit = async () => {
    if (!target || saving || !draft.title.trim() || !draft.prompt.trim()) return;
    const submitted = {
      title: draft.title.trim(),
      prompt: draft.prompt.trim(),
      schedule: draft.schedule.trim(),
    };
    setSaving(true);
    setError(undefined);
    try {
      await onCreate(submitted, target.scope);
      const next = applyRoutineCreate(submitted, { ok: true });
      setDraft(next.draft);
      onClose();
    } catch (cause) {
      const next = applyRoutineCreate(submitted, { ok: false, cause });
      // Keep the exact text the operator entered, including whitespace they
      // may still want to edit after the gateway refused the create.
      setDraft(draft);
      setError(next.error ?? describeRoutineError(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BaseSheet visible={visible} title="New routine" eyebrow="ROUTINE" onClose={onClose}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {targets.length === 0 ? (
          <Text variant="caption" color="tertiary">No backend currently reports routine support.</Text>
        ) : (
          <>
            <Text variant="micro" color="secondary">WHO RUNS IT</Text>
            <Text variant="micro" color="tertiary">Bots</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {targets.filter((item) => item.kind === 'Bot').map((item) => (
                <Chip key={item.key} label={item.label} selected={targetKey === item.key} onPress={() => setTargetKey(item.key)} />
              ))}
            </ScrollView>
            <Text variant="micro" color="tertiary">Backends</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {targets.filter((item) => item.kind === 'Backend').map((item) => (
                <Chip key={item.key} label={item.label} selected={targetKey === item.key} onPress={() => setTargetKey(item.key)} />
              ))}
            </ScrollView>
            <TextField value={draft.title} onChangeText={(title) => setDraft((value) => ({ ...value, title }))} placeholder="Routine name" accessibilityLabel="Routine name" editable={!saving} />
            <TextField value={draft.prompt} onChangeText={(prompt) => setDraft((value) => ({ ...value, prompt }))} placeholder="What should it do?" accessibilityLabel="Routine prompt" multiline editable={!saving} />
            <SchedulePicker
              value={draft.schedule}
              onChange={(schedule) => setDraft((value) => ({ ...value, schedule }))}
            />
            <Text variant="micro" color="secondary">START WITH A TEMPLATE</Text>
            <View style={styles.templates}>
              {ROUTINE_TEMPLATES.map((template) => (
                <ListRow
                  key={template.key}
                  title={template.label}
                  subtitle={template.description}
                  onPress={() => !saving && setDraft((value) => applyRoutineTemplate(value, template.key))}
                />
              ))}
            </View>
            {error ? <Text variant="caption" color="statusDisconnected" selectable>{error}</Text> : null}
            <Button
              label={saving ? 'Saving…' : 'Save routine'}
              busy={saving}
              disabled={saving || !target || !draft.title.trim() || !draft.prompt.trim()}
              onPress={() => void submit()}
            />
          </>
        )}
      </ScrollView>
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: Spacing.two, paddingBottom: Spacing.five },
  chips: { gap: Spacing.two, alignItems: 'center' },
  templates: { gap: Spacing.one },
});
