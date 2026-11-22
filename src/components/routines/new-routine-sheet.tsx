import { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, ScrollView, StyleSheet, View } from 'react-native';

import { BaseSheet, Button, Chip, ListRow, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import type { PublicBot } from '@/lib/gateway/bots';
import { ROUTINE_TEMPLATES, applyRoutineTemplate } from '@/lib/gateway/routine-templates';
import { applyRoutineCreate, describeRoutineError, type RoutineDraft } from '@/lib/gateway/routines';
import { botReportedRoutable } from '@/lib/gateway/roster-tap';
import { unsetBotsLabel } from '@/lib/gateway/roster-sections';
import { SchedulePicker } from './schedule-picker';

import { routineTargets, type RoutineCreateScope, type RoutineTarget } from '@/lib/routines/targets';

export { routineTargets, type RoutineCreateScope, type RoutineTarget };

const INITIAL_DRAFT: RoutineDraft = { title: '', prompt: '', schedule: '0 9 * * *' };

export function NewRoutineSheet({
  visible,
  targets,
  bots,
  initialBackendId,
  initialBotId,
  onClose,
  onCreate,
}: {
  visible: boolean;
  targets: RoutineTarget[];
  /** The roster's verdict on each Bot; without it every Bot target stays offered. */
  bots?: readonly PublicBot[];
  initialBackendId?: string;
  initialBotId?: string;
  onClose: () => void;
  onCreate: (input: RoutineDraft, scope: RoutineCreateScope) => Promise<unknown>;
}) {
  const botsById = useMemo(() => new Map((bots ?? []).map((bot) => [bot.id, bot] as const)), [bots]);
  const allBotTargets = useMemo(() => targets.filter((target) => target.kind === 'Bot'), [targets]);
  // Only Bots the Gate reports routable can run a routine; the roster and the
  // chat already use this same verdict, so a chip never promises a run the
  // Gate would refuse. A Bot named only by a routine row has no roster verdict
  // and keeps its chip rather than being hidden on no evidence.
  const botTargets = useMemo(
    () => allBotTargets.filter((target) => {
      const bot = target.scope.botId ? botsById.get(target.scope.botId) : undefined;
      return !bot || botReportedRoutable(bot);
    }),
    [allBotTargets, botsById],
  );
  const backendTargets = useMemo(() => targets.filter((target) => target.kind === 'Backend'), [targets]);
  const offeredTargets = useMemo(() => {
    const offered = new Set([...botTargets, ...backendTargets].map((target) => target.key));
    return targets.filter((target) => offered.has(target.key));
  }, [backendTargets, botTargets, targets]);
  const hiddenBotCount = allBotTargets.length - botTargets.length;

  const defaultTarget = useMemo(
    () => offeredTargets.find((target) =>
      target.kind === 'Bot' &&
      target.scope.botId === initialBotId &&
      (!initialBackendId || target.scope.backendId === initialBackendId),
    ) ??
      offeredTargets.find((target) => target.kind === 'Backend' && target.scope.backendId === initialBackendId) ??
      offeredTargets[0],
    [initialBackendId, initialBotId, offeredTargets],
  );
  const [targetKey, setTargetKey] = useState(defaultTarget?.key ?? '');
  const [draft, setDraft] = useState<RoutineDraft>(INITIAL_DRAFT);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const selectedKey = offeredTargets.some((item) => item.key === targetKey) ? targetKey : (defaultTarget?.key ?? '');
  const target = offeredTargets.find((item) => item.key === selectedKey) ?? defaultTarget;
  const dirty =
    draft.title !== INITIAL_DRAFT.title ||
    draft.prompt !== INITIAL_DRAFT.prompt ||
    draft.schedule !== INITIAL_DRAFT.schedule;

  // VS-137: Android Back with a dirty draft keeps it rather than discarding it.
  // This is the "preserve" option, not a discard prompt: the parent keeps this
  // sheet mounted while it is closed, so reopening restores the title, prompt
  // and schedule exactly as typed and one Back can never lose the work. A
  // clean close only resets an already-initial draft.
  const requestClose = useCallback(() => {
    if (saving) return;
    if (!dirty) setDraft(INITIAL_DRAFT);
    onClose();
  }, [dirty, onClose, saving]);

  useEffect(() => {
    if (!visible) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      requestClose();
      return true;
    });
    return () => subscription.remove();
  }, [requestClose, visible]);

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
    <BaseSheet visible={visible} title="New routine" eyebrow="ROUTINE" onClose={requestClose}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {targets.length === 0 ? (
          <Text variant="caption" color="tertiary">No backend currently reports routine support.</Text>
        ) : (
          <>
            <Text variant="micro" color="secondary">WHO RUNS IT</Text>
            <Text variant="micro" color="tertiary">Bots</Text>
            {botTargets.length > 0 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                {botTargets.map((item) => (
                  <Chip key={item.key} label={item.label} selected={selectedKey === item.key} onPress={() => setTargetKey(item.key)} />
                ))}
              </ScrollView>
            ) : null}
            {hiddenBotCount > 0 ? (
              <Text variant="micro" color="tertiary">{unsetBotsLabel(hiddenBotCount)}</Text>
            ) : null}
            <Text variant="micro" color="tertiary">Backends</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {backendTargets.map((item) => (
                <Chip key={item.key} label={item.label} selected={selectedKey === item.key} onPress={() => setTargetKey(item.key)} />
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
