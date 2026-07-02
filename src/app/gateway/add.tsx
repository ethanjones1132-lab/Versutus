import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from 'react-native';

import { Button, Card, Screen, Text, TextField } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';

export default function AddGatewayScreen() {
  const router = useRouter();
  const { addGateway, connectGateway } = useGateway();
  const [name, setName] = useState('Home PC');
  const [url, setUrl] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [token, setToken] = useState('');
  const [sessionKey, setSessionKey] = useState('agent:main:main');
  const [agentId, setAgentId] = useState('main');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      const discoverySource = url.includes('.ts.net') || url.startsWith('wss://') ? 'tailscale' : 'manual';
      const gateway = await addGateway({
        name,
        url,
        token: token || undefined,
        sessionKey: showAdvanced ? sessionKey : undefined,
        agentId: showAdvanced ? agentId : undefined,
        discoverySource,
      });
      await connectGateway(gateway);
      router.replace('/chat');
    } catch (error) {
      Alert.alert('Could not save gateway', error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView
        style={styles.keyboard}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Card padding={Spacing.four} style={styles.sheet}>
          <Text color="secondary">
            Usually you do not need this — Versutus connects automatically via Tailscale. Use manual add only for
            custom URLs or tokens.
          </Text>

          <Field label="Name" value={name} onChangeText={setName} />
          <Field
            label="Gateway URL"
            value={url}
            onChangeText={setUrl}
            placeholder="wss://yourpc.tailnet.ts.net:443"
            autoCapitalize="none"
          />

          <AdvancedOptions
            expanded={showAdvanced}
            onExpandedChange={setShowAdvanced}
            token={token}
            onTokenChange={setToken}
            sessionKey={sessionKey}
            onSessionKeyChange={setSessionKey}
            agentId={agentId}
            onAgentIdChange={setAgentId}
          />

          <Button
            label="Save & connect"
            onPress={() => void handleSave()}
            disabled={saving || !url.trim()}
          />
        </Card>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  autoCapitalize,
  secureTextEntry,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  secureTextEntry?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text variant="caption" color="secondary">
        {label}
      </Text>
      <TextField
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        autoCapitalize={autoCapitalize}
        secureTextEntry={secureTextEntry}
      />
    </View>
  );
}

function AdvancedOptions({
  expanded,
  onExpandedChange,
  token,
  onTokenChange,
  sessionKey,
  onSessionKeyChange,
  agentId,
  onAgentIdChange,
}: {
  expanded: boolean;
  onExpandedChange: (value: boolean) => void;
  token: string;
  onTokenChange: (value: string) => void;
  sessionKey: string;
  onSessionKeyChange: (value: string) => void;
  agentId: string;
  onAgentIdChange: (value: string) => void;
}) {
  return (
    <View style={styles.advanced}>
      <Pressable onPress={() => onExpandedChange(!expanded)}>
        <Text variant="link" color="accent">
          {expanded ? 'Hide advanced' : 'Advanced options'}
        </Text>
      </Pressable>

      {expanded ? (
        <>
          <Field label="Token (optional)" value={token} onChangeText={onTokenChange} autoCapitalize="none" secureTextEntry />
          <Field label="Session key" value={sessionKey} onChangeText={onSessionKeyChange} autoCapitalize="none" />
          <Field label="Agent ID" value={agentId} onChangeText={onAgentIdChange} autoCapitalize="none" />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  keyboard: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    margin: Spacing.four,
    borderRadius: Radius.xl,
    gap: Spacing.three,
  },
  field: {
    gap: Spacing.one,
  },
  advanced: {
    gap: Spacing.two,
  },
});