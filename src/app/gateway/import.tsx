import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Button, Card, ErrorCard, Screen, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import {
  botHandoffImportCopy,
  botHandoffImportPlan,
  parseBotHandoffText,
} from '@/lib/gateway/handoff-import';

/** A file the operator picked, or why its content could not be read. */
type PickedHandoffFile = { name: string; content: string; error?: string };

/** Which source refused, and why — so Retry re-runs that exact action. */
type ImportFailure = { source: 'clipboard' | 'file' | 'import'; message: string };

/**
 * Open the document picker for the packet file and read it as text. A
 * cancelled picker answers `undefined` so the pasted field is left alone.
 * `expo-file-system` reads the picked URI; a read or decode failure becomes
 * the refusal the card shows, not a crash.
 */
async function pickHandoffFile(): Promise<PickedHandoffFile | undefined> {
  const result = await DocumentPicker.getDocumentAsync({
    type: 'application/json',
    copyToCacheDirectory: true,
  });
  if (result.canceled || result.assets.length === 0) return undefined;
  const asset = result.assets[0];
  try {
    const FileSystem = await import('expo-file-system');
    const content = await FileSystem.readAsStringAsync(asset.uri);
    return { name: asset.name ?? 'packet.json', content };
  } catch {
    return { name: asset.name ?? 'packet.json', content: '', error: 'The picked file could not be read.' };
  }
}

/**
 * D6 on the receiving host: a packet exported from another gateway is pasted,
 * read from the clipboard or picked as a file and, only if it is a real
 * packet and this gateway can create Bots, becomes a new Bot here.
 *
 * The file picker (`expo-document-picker`) opens the SAME `.json` packet the
 * export writes, and its content lands in the same TextField the paste row
 * feeds — so a picked file and a pasted text go through the identical
 * `handoff-import` plan the tests pin, and memory and credentials are never
 * on it either way.
 */
export default function ImportBotScreen() {
  const router = useRouter();
  const { hasBotManagement, createBot, requestSurface } = useGateway();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ImportFailure | undefined>(undefined);
  const [fileNote, setFileNote] = useState<string | undefined>(undefined);

  const clearFailure = () => setFailure(undefined);

  const plan = useMemo(
    () => botHandoffImportPlan(parseBotHandoffText(text), { canCreateBots: hasBotManagement }),
    [text, hasBotManagement],
  );

  const readClipboard = () => {
    void Clipboard.getStringAsync()
      .then((value) => {
        setText(value ?? '');
        clearFailure();
      })
      .catch(() => setFailure({ source: 'clipboard', message: 'The clipboard could not be read.' }));
  };

  const pickFile = () => {
    void pickHandoffFile()
      .then((picked) => {
        if (picked === undefined) return; // picker cancelled: leave the field alone
        setText(picked.content);
        clearFailure();
        if (picked.error) {
          setFailure({ source: 'file', message: picked.error });
          setFileNote(undefined);
        } else {
          setFileNote(`Read ${picked.name}: ${picked.content.toLocaleString()} characters.`);
        }
      })
      .catch(() => setFailure({ source: 'file', message: 'The file could not be read.' }));
  };

  const handleImport = () => {
    if (!plan.ok || busy) return;
    setBusy(true);
    clearFailure();
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
        setFailure({ source: 'import', message: cause instanceof Error ? cause.message : String(cause) });
      })
      .finally(() => setBusy(false));
  };

  const retryFailure = () => {
    if (failure?.source === 'clipboard') readClipboard();
    else if (failure?.source === 'file') pickFile();
    else if (failure?.source === 'import') handleImport();
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        {failure ? (
          <ErrorCard
            cause={failure.message}
            affected={
              failure.source === 'import' ? 'creating this Bot on this gateway' : 'reading the handoff packet'
            }
            next={
              failure.source === 'clipboard'
                ? 'Tap Read clipboard again, or paste the packet by hand.'
                : failure.source === 'file'
                  ? 'Tap Pick file again, or paste the packet by hand.'
                  : 'Fix the gateway issue, then tap Import again.'
            }
            onRetry={retryFailure}
            onDismiss={clearFailure}
          />
        ) : null}
        <Card variant="surface" padding={Spacing.three} style={styles.card}>
          <Text variant="body" color="secondary">
            Paste a Bot handoff packet, pick its file, or read one from the clipboard, then import
            it as a new Bot on this gateway.
          </Text>
          <TextField
            value={text}
            onChangeText={(value) => {
              setText(value);
              setFileNote(undefined);
            }}
            placeholder="Paste a Bot handoff packet"
            multiline
            accessibilityLabel="Bot handoff packet"
          />
          <View style={styles.sourcesRow}>
            <Button label="Read clipboard" variant="secondary" onPress={readClipboard} />
            <Button label="Pick file" variant="secondary" onPress={pickFile} />
          </View>
        </Card>

        {text.trim() ? (
          <Card variant="surface" padding={Spacing.three} style={styles.card}>
            <Text variant="body" color={plan.ok ? 'secondary' : 'tertiary'}>
              {botHandoffImportCopy(plan)}
            </Text>
            {fileNote ? (
              <Text variant="micro" color="tertiary">
                {fileNote}
              </Text>
            ) : null}
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
  sourcesRow: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
});
