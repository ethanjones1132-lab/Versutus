import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { CouncilCompareView } from '@/components/chat/council-compare-view';
import { Button, Card, Chip, Screen, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import type { PublicBot } from '@/lib/gateway/bots';
import {
  councilDisabledCopy,
  councilPromptIssue,
  councilRoomName,
  councilTargets,
  runCouncil,
  type CouncilColumn,
} from '@/lib/gateway/council';

/**
 * D7's screen: one prompt, up to three Bots, answers side by side.
 *
 * The app has no per-Bot "ask and await one answer" call, so the send reuses
 * the existing surface that does return text per Bot — the Gate's group round.
 * One transient room is created for the selected Bots, the prompt is sent once
 * (the Gate fans out per Bot server-side), and the returned replies are handed
 * to the shipped `runCouncil`, which keeps the columns in roster order and
 * gives each Bot its own failure. The room is deleted in a `finally`; a
 * comparison leaves no room behind.
 */
export default function CouncilScreen() {
  const router = useRouter();
  const { status, hasGroupRooms, botGroups, listBots, openBot, requestSurface } = useGateway();
  const [roster, setRoster] = useState<PublicBot[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [columns, setColumns] = useState<CouncilColumn[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (status !== 'connected') return undefined;
    let cancelled = false;
    void listBots()
      .then((bots) => {
        if (!cancelled) setRoster(bots);
      })
      .catch(() => {
        if (!cancelled) setRoster([]);
      });
    return () => {
      cancelled = true;
    };
  }, [status, listBots]);

  // The selected Bots, in the roster's own order, capped like any council.
  const targets = useMemo(() => {
    const selectedIds = new Set(selected);
    return councilTargets(
      roster.filter((bot) => selectedIds.has(bot.id)),
      3,
    );
  }, [roster, selected]);

  const toggleBot = (botId: string) => {
    setSelected((previous) =>
      previous.includes(botId) ? previous.filter((id) => id !== botId) : [...previous, botId],
    );
  };

  const promptIssue = councilPromptIssue(prompt);

  const canCompare =
    status === 'connected' &&
    hasGroupRooms &&
    targets.length >= 2 &&
    prompt.trim().length > 0 &&
    !promptIssue &&
    !sending;

  const handleCompare = async () => {
    const text = prompt.trim();
    const issue = councilPromptIssue(text);
    if (issue) {
      setError(issue);
      return;
    }
    if (!text || targets.length < 2 || sending) return;
    setSending(true);
    setError(undefined);
    setColumns([]);
    let roomId: string | undefined;
    try {
      const room = await botGroups.create({
        name: councilRoomName(text),
        memberIds: targets.map((target) => target.botId),
      });
      roomId = room.id;
      const round = await botGroups.send(room.id, { text });
      const result = await runCouncil(text, targets, async (target) => {
        const miss = round.errors?.find((candidate) => candidate.botId === target.botId);
        if (miss) throw new Error(miss.error);
        return round.replies.find((candidate) => candidate.botId === target.botId)?.text ?? '';
      });
      setColumns(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (roomId) await botGroups.deleteGroup(roomId).catch(() => undefined);
      setSending(false);
    }
  };

  const handlePressColumn = (column: CouncilColumn) => {
    if (column.state !== 'answered') return;
    void openBot(column.botId)
      .then((opened) => {
        if (!opened) {
          requestSurface({ kind: 'roster' });
          return;
        }
        requestSurface({ kind: 'bot', botId: column.botId });
        router.navigate('/chat');
      })
      .catch(() => requestSurface({ kind: 'roster' }));
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.heading}>
          <Text variant="title">Council</Text>
          <Text variant="caption" color="secondary">
            Ask up to three Bots the same prompt and compare their answers side by side.
          </Text>
        </View>

        {!hasGroupRooms ? (
          <Card variant="surface" padding={Spacing.three}>
            <Text variant="body" color="secondary">
              {councilDisabledCopy()}
            </Text>
          </Card>
        ) : (
          <>
            <Card variant="surface" padding={Spacing.three} style={styles.card}>
              <Text variant="micro" color="tertiary">
                Bots to compare ({targets.length}/3)
              </Text>
              <View style={styles.chips}>
                {roster.map((bot) => (
                  <Chip
                    key={bot.id}
                    label={bot.displayName || bot.id}
                    selected={selected.includes(bot.id)}
                    onPress={() => toggleBot(bot.id)}
                  />
                ))}
              </View>
              <TextField
                value={prompt}
                onChangeText={setPrompt}
                placeholder="One prompt for every Bot"
                multiline
                accessibilityLabel="Council prompt"
              />
              <Button
                label={sending ? 'Asking…' : 'Compare'}
                onPress={() => void handleCompare()}
                disabled={!canCompare}
              />
              {error || promptIssue ? (
                <Text variant="caption" color="tertiary">
                  {error ?? promptIssue}
                </Text>
              ) : null}
            </Card>

            {columns.length > 0 ? (
              <CouncilCompareView columns={columns} onPressColumn={handlePressColumn} />
            ) : null}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: Spacing.four,
    gap: Spacing.four,
  },
  heading: {
    gap: Spacing.one,
  },
  card: {
    gap: Spacing.three,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
});
