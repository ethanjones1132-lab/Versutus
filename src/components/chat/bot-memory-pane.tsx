import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Skeleton, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import {
  botMemoryCopy,
  botMemoryFromUnknown,
  memoryFileSearch,
  memorySaveConfirmationCopy,
  type BotMemory,
} from '@/lib/gateway/bot-memory';

type MemoryState = { botId: string; memory: BotMemory; failed: boolean };
type Editing = { name: string; text: string };

/**
 * P2: a Bot's memory, read-first. The Gate reads `memories/MEMORY.md` and
 * `memories/USER.md` on the host and answers `bots.memory`; this pane shows
 * the raw files and searches them. An edit is two taps and a confirmation —
 * nothing is written until the operator confirms, and the Gate still refuses
 * any name that is not memory. A failed read says so rather than reading as
 * empty.
 */
export function BotMemoryPane({ botId }: { botId: string }) {
  const { status, gatewayRequest } = useGateway();
  const [state, setState] = useState<MemoryState | null>(null);
  const [query, setQuery] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    if (status !== 'connected') return;
    let cancelled = false;
    void gatewayRequest('bots.memory', { id: botId })
      .then((payload) => {
        if (!cancelled) setState({ botId, memory: botMemoryFromUnknown(payload), failed: false });
      })
      .catch(() => {
        if (!cancelled) setState({ botId, memory: { files: [] }, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [botId, status, gatewayRequest, reloadKey]);

  const save = useCallback(async () => {
    if (!editing) return;
    setSaving(true);
    setEditError(null);
    try {
      await gatewayRequest('bots.memory.write', { id: botId, name: editing.name, text: editing.text });
      setEditing(null);
      setConfirming(false);
      setReloadKey((n) => n + 1);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [botId, editing, gatewayRequest]);

  const settled = state?.botId === botId ? state : null;
  const matches = settled ? memoryFileSearch(settled.memory.files, query) : [];

  return (
    <View style={styles.pane}>
      <Text variant="micro" color="tertiary">
        MEMORY
      </Text>

      {!settled ? (
        <Skeleton width="90%" height={40} />
      ) : settled.failed ? (
        <View style={styles.block}>
          <Text variant="caption" color="accentWarm">
            Memory could not be read from the Gate host.
          </Text>
          <Button label="Retry" variant="ghost" size="sm" onPress={() => setReloadKey((n) => n + 1)} />
        </View>
      ) : settled.memory.files.length === 0 ? (
        <Text variant="caption" color="secondary">
          {botMemoryCopy(settled.memory)}
        </Text>
      ) : (
        <View style={styles.block}>
          <Text variant="caption" color="tertiary">
            {botMemoryCopy(settled.memory)}
          </Text>
          {settled.memory.files.length > 1 ? (
            <TextField value={query} onChangeText={setQuery} placeholder="Search memory" />
          ) : null}
          {query.trim() && matches.length === 0 ? (
            <Text variant="caption" color="secondary">
              No line matches “{query.trim()}”.
            </Text>
          ) : null}

          {settled.memory.files.map((file) => (
            <View key={file.name} style={styles.fileBlock}>
              <View style={styles.fileHeader}>
                <Text variant="micro" color="tertiary">
                  {file.name}
                </Text>
                {!editing ? (
                  <Button
                    label="Edit"
                    variant="ghost"
                    size="sm"
                    onPress={() => {
                      setEditError(null);
                      setConfirming(false);
                      setEditing({ name: file.name, text: file.text });
                    }}
                  />
                ) : null}
              </View>

              {editing?.name === file.name ? (
                <View style={styles.editBlock}>
                  <TextField
                    value={editing.text}
                    onChangeText={(text) =>
                      setEditing((current) => (current ? { ...current, text } : current))
                    }
                    multiline
                    style={styles.editField}
                  />
                  {confirming ? (
                    <View style={styles.confirmBlock}>
                      <Text variant="caption" color="accentWarm">
                        {memorySaveConfirmationCopy(file.name)}
                      </Text>
                      <View style={styles.editActions}>
                        <Button label="Confirm save" size="sm" onPress={() => void save()} disabled={saving} />
                        <Button
                          label="Cancel"
                          variant="secondary"
                          size="sm"
                          onPress={() => setConfirming(false)}
                          disabled={saving}
                        />
                      </View>
                    </View>
                  ) : (
                    <View style={styles.editActions}>
                      <Button label="Save" size="sm" onPress={() => setConfirming(true)} disabled={saving} />
                      <Button
                        label="Discard"
                        variant="secondary"
                        size="sm"
                        onPress={() => {
                          setConfirming(false);
                          setEditing(null);
                        }}
                        disabled={saving}
                      />
                    </View>
                  )}
                  {editError ? (
                    <Text variant="caption" color="accentWarm">
                      {editError}
                    </Text>
                  ) : null}
                </View>
              ) : (
                matches
                  .filter((match) => match.name === file.name)
                  .map((match) => (
                    <View key={`${match.name}:${match.line}`} style={styles.match}>
                      <Text variant="micro" color="tertiary">
                        {match.name}:{match.line}
                      </Text>
                      <Text variant="mono" selectable>
                        {match.text}
                      </Text>
                    </View>
                  ))
              )}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  pane: { gap: 2 },
  block: { gap: Spacing.one, marginTop: 2 },
  fileBlock: { gap: 2, marginTop: Spacing.one },
  fileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  match: { gap: 1 },
  editBlock: { gap: Spacing.one, marginTop: Spacing.one },
  editField: { minHeight: 96 },
  confirmBlock: { gap: Spacing.one },
  editActions: { flexDirection: 'row', gap: Spacing.two },
});
