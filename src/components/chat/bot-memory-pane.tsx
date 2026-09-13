import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Skeleton, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import {
  botMemoryCopy,
  botMemoryFromUnknown,
  memoryFileSearch,
  type BotMemory,
} from '@/lib/gateway/bot-memory';

type MemoryState = { botId: string; memory: BotMemory; failed: boolean };

/**
 * P2: a Bot's memory, read-first. The Gate reads `memories/MEMORY.md` and
 * `memories/USER.md` on the host and answers `bots.memory`; this pane shows
 * the raw files and searches them. Nothing here edits: an edit belongs behind
 * a confirmation, and a failed read says so rather than reading as empty.
 */
export function BotMemoryPane({ botId }: { botId: string }) {
  const { status, gatewayRequest } = useGateway();
  const [state, setState] = useState<MemoryState | null>(null);
  const [query, setQuery] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

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
          <TextField value={query} onChangeText={setQuery} placeholder="Search memory" />
          {query.trim() && matches.length === 0 ? (
            <Text variant="caption" color="secondary">
              No line matches “{query.trim()}”.
            </Text>
          ) : null}
          {matches.map((match) => (
            <View key={`${match.name}:${match.line}`} style={styles.match}>
              <Text variant="micro" color="tertiary">
                {match.name}:{match.line}
              </Text>
              <Text variant="mono" selectable>
                {match.text}
              </Text>
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
  match: { gap: 1 },
});
