import {
  Host,
  HorizontalDivider,
  LazyColumn,
  ListItem,
  Switch,
  Text as ComposeText,
} from '@expo/ui/jetpack-compose';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, StyleSheet, View } from 'react-native';

import { Button, Screen, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useTokens } from '@/hooks/use-tokens';

function validateGatewayUrl(value: string): { valid: boolean; message: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { valid: false, message: 'Enter a gateway WebSocket URL.' };
  }
  if (!/^wss?:\/\/.+/i.test(trimmed)) {
    return { valid: false, message: 'URL must start with wss:// or ws://.' };
  }
  return { valid: true, message: 'Looks good — ready to save.' };
}

export default function AddGatewayScreen() {
  const router = useRouter();
  const tokens = useTokens();
  const { addGateway, connectGateway } = useGateway();
  const [name, setName] = useState('Home PC');
  const [url, setUrl] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [token, setToken] = useState('');
  const [sessionKey, setSessionKey] = useState('agent:main:main');
  const [agentId, setAgentId] = useState('main');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const urlValidation = useMemo(() => validateGatewayUrl(url), [url]);
  const urlFieldState = !url.trim() ? 'default' : urlValidation.valid ? 'valid' : 'invalid';

  async function handleSave() {
    if (!urlValidation.valid) return;

    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setError(null);
    setSaving(true);
    try {
      const discoverySource = url.includes('.ts.net') || url.startsWith('wss://') ? 'tailscale' : 'manual';
      const gateway = await addGateway({
        name,
        url,
        token: token || undefined,
        sessionKey: showAdvanced ? sessionKey : undefined,
        discoverySource,
      });
      await connectGateway(gateway);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace('/chat');
    } catch (err) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const listColors = {
    containerColor: tokens.background,
    contentColor: tokens.textPrimary,
    supportingContentColor: tokens.textSecondary,
    overlineContentColor: tokens.textTertiary,
  };

  return (
    <Screen>
      <KeyboardAvoidingView style={styles.keyboard}>
        <View style={styles.content}>
          <Host style={styles.listHost}>
            <LazyColumn
              contentPadding={{ start: 0, end: 0, top: 0, bottom: Spacing.five }}
              verticalArrangement={{ spacedBy: 8 }}>
              <ListItem colors={listColors}>
                <ListItem.SupportingContent>
                  <ComposeText color={tokens.textSecondary}>
                    Usually you do not need this — Versutus connects automatically via Tailscale. Use manual add only
                    for custom URLs or tokens.
                  </ComposeText>
                </ListItem.SupportingContent>
              </ListItem>

              <ListItem colors={listColors}>
                <ListItem.OverlineContent>
                  <ComposeText color={tokens.textTertiary}>Name</ComposeText>
                </ListItem.OverlineContent>
                <ListItem.HeadlineContent>
                  <TextField value={name} onChangeText={setName} />
                </ListItem.HeadlineContent>
              </ListItem>

              <ListItem colors={listColors}>
                <ListItem.OverlineContent>
                  <ComposeText color={tokens.textTertiary}>Gateway URL</ComposeText>
                </ListItem.OverlineContent>
                <ListItem.HeadlineContent>
                  <TextField
                    value={url}
                    onChangeText={setUrl}
                    placeholder="wss://yourpc.tailnet.ts.net:443"
                    autoCapitalize="none"
                    validationState={urlFieldState}
                  />
                </ListItem.HeadlineContent>
                {url.trim() ? (
                  <ListItem.SupportingContent>
                    <ComposeText color={urlValidation.valid ? tokens.statusConnected : tokens.accentWarm}>
                      {urlValidation.message}
                    </ComposeText>
                  </ListItem.SupportingContent>
                ) : null}
              </ListItem>

              {error ? (
                <ListItem
                  colors={{
                    ...listColors,
                    containerColor: tokens.accentWarmMuted,
                    supportingContentColor: tokens.textSecondary,
                  }}>
                  <ListItem.OverlineContent>
                    <ComposeText color={tokens.accentWarm}>Could not save gateway</ComposeText>
                  </ListItem.OverlineContent>
                  <ListItem.SupportingContent>
                    <ComposeText color={tokens.textSecondary}>
                      Cause: {error}. Affected: manual gateway entry. Next: Check URL and token, then try again.
                    </ComposeText>
                  </ListItem.SupportingContent>
                </ListItem>
              ) : null}

              <HorizontalDivider color={tokens.glassBorder} />

              <ListItem colors={listColors}>
                <ListItem.HeadlineContent>
                  <ComposeText color={tokens.textPrimary}>Advanced options</ComposeText>
                </ListItem.HeadlineContent>
                <ListItem.TrailingContent>
                  <Switch value={showAdvanced} onCheckedChange={setShowAdvanced} />
                </ListItem.TrailingContent>
              </ListItem>

              {showAdvanced ? (
                <>
                  <ListItem colors={listColors}>
                    <ListItem.OverlineContent>
                      <ComposeText color={tokens.textTertiary}>Token (optional)</ComposeText>
                    </ListItem.OverlineContent>
                    <ListItem.HeadlineContent>
                      <TextField value={token} onChangeText={setToken} autoCapitalize="none" secureTextEntry />
                    </ListItem.HeadlineContent>
                  </ListItem>
                  <ListItem colors={listColors}>
                    <ListItem.OverlineContent>
                      <ComposeText color={tokens.textTertiary}>Session key</ComposeText>
                    </ListItem.OverlineContent>
                    <ListItem.HeadlineContent>
                      <TextField value={sessionKey} onChangeText={setSessionKey} autoCapitalize="none" />
                    </ListItem.HeadlineContent>
                  </ListItem>
                  <ListItem colors={listColors}>
                    <ListItem.OverlineContent>
                      <ComposeText color={tokens.textTertiary}>Agent ID</ComposeText>
                    </ListItem.OverlineContent>
                    <ListItem.HeadlineContent>
                      <TextField value={agentId} onChangeText={setAgentId} autoCapitalize="none" />
                    </ListItem.HeadlineContent>
                  </ListItem>
                </>
              ) : null}
            </LazyColumn>
          </Host>

          <Button
            label="Save & connect"
            onPress={() => void handleSave()}
            disabled={saving || !urlValidation.valid}
            style={styles.save}
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  keyboard: {
    flex: 1,
  },
  content: {
    flex: 1,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.two,
    gap: Spacing.three,
  },
  listHost: {
    flex: 1,
    alignSelf: 'stretch',
  },
  save: {
    marginBottom: Spacing.four,
  },
});