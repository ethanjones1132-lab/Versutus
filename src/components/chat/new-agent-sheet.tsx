import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { BaseSheet, Button, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { filterModels, groupByProvider, modelPickerName, sameModelId } from '@/lib/gateway/model-selection';

export type NewAgentDraft = {
  name: string;
  soul?: string;
  inheritKeys: boolean;
  description?: string;
  modelId?: string | null;
  providerId?: string | null;
};

/**
 * One catalogue row the pin can be set from. Same shape the chat model picker
 * consumes, so the parent passes the list it already holds rather than this
 * sheet fetching its own.
 */
export type BotModelOption = {
  id: string;
  provider?: string;
  providerId?: string;
  modelId?: string;
  available?: boolean;
};

/** Prefill for an existing Bot — the same sheet doubles as the edit form. */
export type EditAgentInitial = {
  name: string;
  description: string;
  modelId: string;
  providerId: string;
};

export function NewAgentSheet({
  visible,
  busy,
  error,
  initial,
  models = [],
  onClose,
  onSubmit,
}: {
  visible: boolean;
  busy?: boolean;
  error?: string;
  /** Present when editing an existing Bot; the parent keys this sheet by target so state resets. */
  initial?: EditAgentInitial;
  /**
   * The gateway's model catalogue. When it is non-empty the pin is chosen from
   * it, because typing `provider/model-id` by hand pins a model that may not
   * exist and only fails later, mid-turn. An empty catalogue (offline, or a
   * gateway that serves none) falls back to the free-text fields so the
   * capability is never lost.
   */
  models?: BotModelOption[];
  onClose: () => void;
  onSubmit: (draft: NewAgentDraft) => void;
}) {
  const editing = Boolean(initial);
  const [name, setName] = useState(initial?.name ?? '');
  const [soul, setSoul] = useState('');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [modelId, setModelId] = useState(initial?.modelId ?? '');
  const [providerId, setProviderId] = useState(initial?.providerId ?? '');
  const [inheritKeys, setInheritKeys] = useState(true);
  const [modelQuery, setModelQuery] = useState('');

  // A catalogue runs to hundreds of entries; rendering all of them inline would
  // bury the Save button. Cap what is drawn and say how many were not.
  const MODEL_ROW_CAP = 8;
  const matches = useMemo(() => filterModels(models, modelQuery), [models, modelQuery]);
  const sections = useMemo(() => groupByProvider(matches.slice(0, MODEL_ROW_CAP)), [matches]);
  const hiddenModelCount = Math.max(0, matches.length - MODEL_ROW_CAP);
  const pinned = modelId.trim();

  const reset = () => {
    setName('');
    setSoul('');
    setDescription('');
    setModelId('');
    setProviderId('');
    setInheritKeys(true);
    setModelQuery('');
  };

  return (
    <BaseSheet
      visible={visible}
      eyebrow="BOTS"
      title={editing ? 'Edit Agent' : 'New Agent'}
      onClose={() => {
        reset();
        onClose();
      }}
      closeLabel="Dismiss">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.pad}>
        <Text variant="caption" color="tertiary" style={styles.blurb}>
          {editing
            ? 'Applies only the fields you fill in — a blank field leaves what the Gate holds untouched.'
            : 'Creates a Hermes profile on the host. Inherit copies default provider keys; empty starts with none.'}
        </Text>
        <Text variant="micro" color="secondary">
          Name
        </Text>
        {/* The name is the profile's identity — editing renames nothing, so it stays read-only here. */}
        <TextField value={name} onChangeText={setName} placeholder="researcher" autoCapitalize="none" editable={!editing} />
        <Text variant="micro" color="secondary" style={styles.gap}>
          Description
        </Text>
        <TextField value={description} onChangeText={setDescription} placeholder="Reads code and writes findings" />
        <Text variant="micro" color="secondary" style={styles.gap}>
          Soul
        </Text>
        <TextField
          value={soul}
          onChangeText={setSoul}
          placeholder={editing ? 'Leave unchanged' : 'Standing personality and instructions'}
          multiline
        />
        <Text variant="micro" color="secondary" style={styles.gap}>
          Model pin
        </Text>
        {models.length > 0 ? (
          <>
            <Text variant="caption" color={pinned ? 'primary' : 'secondary'}>
              {pinned
                ? `${modelPickerName({ id: pinned, modelId: pinned, providerId })}${providerId ? ` · ${providerId}` : ''}`
                : 'Inherits the profile default'}
            </Text>
            <TextField
              value={modelQuery}
              onChangeText={setModelQuery}
              placeholder="Search models"
              autoCapitalize="none"
            />
            {/* Deliberately NOT a nested ScrollView: this sheet's own ScrollView
                keeps the Save button reachable on a short phone, and a vertical
                scroller inside a vertical scroller fights it for the gesture on
                Android. The rows render inline, capped, and the search narrows
                them -- which is why the cap is stated rather than hidden. */}
            <View style={styles.modelList}>
              {sections.length === 0 ? (
                <Text variant="caption" color="secondary">
                  No model matches that search.
                </Text>
              ) : null}
              {sections.map((section) => (
                <View key={section.key}>
                  <Text variant="micro" color="secondary" style={styles.gap}>
                    {section.title}
                  </Text>
                  {section.data.map((item) => {
                    const selected = sameModelId(item.id, pinned) || item.id === pinned;
                    return (
                      <Pressable
                        key={item.id}
                        accessibilityRole="button"
                        accessibilityState={{ selected, disabled: item.available === false }}
                        accessibilityLabel={`Pin model ${modelPickerName(item)}`}
                        disabled={item.available === false}
                        onPress={() => {
                          setModelId(item.modelId ?? item.id);
                          setProviderId(item.providerId ?? item.provider ?? '');
                        }}
                        style={[styles.modelRow, selected && styles.modelRowSelected]}>
                        <Text
                          variant="caption"
                          numberOfLines={2}
                          color={item.available === false ? 'tertiary' : 'primary'}>
                          {modelPickerName(item)}
                          {item.available === false ? ' — provider not signed in' : ''}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ))}
              {hiddenModelCount > 0 ? (
                <Text variant="micro" color="secondary" style={styles.gap}>
                  {hiddenModelCount} more — search to narrow the list.
                </Text>
              ) : null}
            </View>
          </>
        ) : (
          <>
            {/* No catalogue reachable — keep the manual path rather than
                leaving the operator with no way to pin a model at all. */}
            <TextField value={modelId} onChangeText={setModelId} placeholder="provider/model-id" autoCapitalize="none" />
            <Text variant="micro" color="secondary" style={styles.gap}>
              Provider pin
            </Text>
            <TextField value={providerId} onChangeText={setProviderId} placeholder="provider-id" autoCapitalize="none" />
          </>
        )}
        {!editing ? (
          <Button
            label={inheritKeys ? 'Inherit keys from default' : 'Empty key set'}
            variant="ghost"
            selected={inheritKeys}
            onPress={() => setInheritKeys((value) => !value)}
          />
        ) : null}
        {error ? (
          <Text variant="caption" color="statusDisconnected">
            {error}
          </Text>
        ) : null}
        <Button
          label={busy ? (editing ? 'Saving…' : 'Creating…') : editing ? 'Save' : 'Create'}
          disabled={busy || !name.trim()}
          busy={busy}
          onPress={() =>
            onSubmit({
              name: name.trim(),
              soul: soul.trim() || undefined,
              inheritKeys,
              description: description.trim() || undefined,
              modelId: editing ? modelId.trim() || null : modelId.trim() || undefined,
              providerId: editing ? providerId.trim() || null : providerId.trim() || undefined,
            })
          }
        />
      </ScrollView>
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  modelList: {
    gap: Spacing.one,
  },
  modelRow: {
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.two,
    borderRadius: 8,
    minHeight: 44,
    justifyContent: 'center',
  },
  modelRowSelected: {
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  pad: { paddingHorizontal: Spacing.two, paddingBottom: Spacing.four, gap: Spacing.one },
  blurb: { marginBottom: Spacing.two },
  gap: { marginTop: Spacing.two },
});
