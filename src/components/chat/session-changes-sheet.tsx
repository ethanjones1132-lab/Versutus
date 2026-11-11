import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { CodeBlock } from '@/components/chat/markdown/code-block';
import { BaseSheet, ListRow, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import type { SessionChanges } from '@/lib/gateway/manifest-client';

export function SessionChangesSheet({
  visible,
  sessionId,
  onClose,
  loadChanges,
}: {
  visible: boolean;
  sessionId?: string;
  onClose: () => void;
  loadChanges: (sessionId: string) => Promise<SessionChanges>;
}) {
  const tokens = useTokens();
  const [result, setResult] = useState<SessionChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible || !sessionId) return;
    let current = true;
    void Promise.resolve().then(() => {
      if (!current) return null;
      setLoading(true);
      setResult(null);
      setError(null);
      setSelectedIndex(0);
      return loadChanges(sessionId);
    }).then((changes) => {
      if (!changes) return;
      if (current) setResult(changes);
    }).catch((cause: unknown) => {
      if (current) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [loadChanges, sessionId, visible]);

  const selected = result?.files[selectedIndex];

  return (
    <BaseSheet visible={visible} eyebrow="SESSION REVIEW" title="Changes" onClose={onClose} closeLabel="Dismiss">
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        {loading ? <Text color="tertiary">Loading session changes…</Text> : null}
        {error ? <Text color="secondary">Could not load session changes: {error}</Text> : null}
        {result && !result.supported ? (
          <Text color="secondary">This backend does not expose session diffs. Changes are unavailable here.</Text>
        ) : null}
        {result?.supported ? (
          <>
            <Text variant="caption" color="tertiary">Read-only review. This backend does not offer approve or reject for file changes.</Text>
            {result.files.length === 0 ? <Text color="secondary">No changed files in this session.</Text> : null}
            <View style={[styles.files, { backgroundColor: tokens.backgroundInset }]}>
              {result.files.map((file, index) => (
                <ListRow
                  key={`${file.path}:${index}`}
                  title={file.path}
                  subtitle={file.status === 'too_large'
                    ? 'Diff too large to display'
                    : `${file.status} · +${file.additions} −${file.deletions}`}
                  selected={index === selectedIndex}
                  chevron={false}
                  onPress={() => setSelectedIndex(index)}
                />
              ))}
            </View>
            {selected?.patch ? <CodeBlock code={selected.patch} language="diff" /> : null}
            {selected?.status === 'too_large' ? (
              <Text color="tertiary">This file’s patch exceeds the Gate’s 200 KB per-session display limit.</Text>
            ) : null}
            {selected && !selected.patch && selected.status !== 'too_large' ? (
              <Text color="tertiary">The backend listed this file but did not provide a patch.</Text>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: Spacing.two,
    paddingBottom: Spacing.two,
  },
  files: {
    borderRadius: Radius.md,
    overflow: 'hidden',
  },
});
