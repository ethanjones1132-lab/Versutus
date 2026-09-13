import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { Button, Card, Screen, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import {
  botHandoffImportCopy,
  botHandoffImportPlan,
  parseBotHandoffText,
} from '@/lib/gateway/handoff-import';

/**
 * D6 on the receiving host: a packet exported from another gateway is pasted
 * (or read from the clipboard) and, only if it is a real packet and this
 * gateway can create Bots, becomes a new Bot here.
 *
 * The clipboard is the picker this build actually has: no document picker is
 * installed and the Android share filter carries text only, so a `.json` file
 * cannot be handed to the app directly. The packet text is the same JSON the
 * export writes, and the validation is the same `handoff-import` fold the
 * tests pin — memory and credentials are never on it.
 */
export default function ImportBotScreen() {
  const router = useRouter();
  const { hasBotManagement, createBot, requestSurface } = useGateway();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const plan = useMemo(
    () => botHandoffImportPlan(parseBotHandoffText(text), { canCreateBots: hasBotManagement }),
    [text, hasBotManagement],
  );

  const readClipboard = () => {
    void Clipboard.getStringAsync()
      .then((value) => setText(value ?? ''))
      .catch(() => setError('The clipboard could not be read.'));
  };

  const handleImport = () => {
    if (!plan.ok || busy) return;
    setBusy(true);
    setError(undefined);
    const bot = plan.bot;
    void createBot({
      name: bot.name ?? bot.id,
      soul: bot.soul,
      description: bot.description,
      modelId: bot.modelId ?? undefined,
      providerId: bot.providerId ?? undefined,
    })
      .then(() => {
        // The new Bot is on the receiving gateway: show the roster, where it
        // now appears, rather than a sheet that would open a thread the app
        // has not read yet.
        requestSurface({ kind: 'roster' });
        router.navigate('/chat');
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setBusy(false));
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Card variant="surface" padding={Spacing.three} style={styles.card}>
          <Text variant="body" color="secondary">
            Paste a Bot handoff packet, or read one from the clipboard, then import it as a new
            Bot on this gateway.
          </Text>
          <TextField
            value={text}
            onChangeText={setText}
            placeholder="Paste a Bot handoff packet"
            multiline
            accessibilityLabel="Bot handoff packet"
          />
          <Button label="Read clipboard" variant="secondary" onPress={readClipboard} />
        </Card>

        {text.trim() ? (
          <Card variant="surface" padding={Spacing.three} style={styles.card}>
            <Text variant="body" color={plan.ok ? 'secondary' : 'tertiary'}>
              {botHandoffImportCopy(plan)}
            </Text>
            {plan.ok ? (
              <>
                <Text variant="micro" color="tertiary">
                  Never in the packet: {plan.excluded.join(', ')}.
                </Text>
                <Button label="Import" onPress={handleImport} disabled={busy} />
              </>
            ) : null}
          </Card>
        ) : null}

        {error ? (
          <Text variant="caption" color="tertiary">
            {error}
          </Text>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: Spacing.four,
    gap: Spacing.four,
  },
  card: {
    gap: Spacing.three,
  },
});
