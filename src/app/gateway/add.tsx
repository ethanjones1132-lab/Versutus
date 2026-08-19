import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { TransportSecurityCard } from '@/components/gateway/transport-security-card';
import { Button, Card, ErrorCard, Screen, Text, TextField } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { humanizeGatewayError } from '@/lib/gateway/error-humanizer';
import { requestGatewayAccess, type AccessRequestResult } from '@/lib/portal/access';
import { identifyGateway, type GatewayIdentity } from '@/lib/portal/identify';

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default function AddGatewayScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    url?: string | string[];
    token?: string | string[];
    name?: string | string[];
    sessionKey?: string | string[];
    agentId?: string | string[];
  }>();
  const { addGateway, connectGateway } = useGateway();
  const [name, setName] = useState(() => firstParam(params.name) ?? 'Home PC');
  const [url, setUrl] = useState(() => firstParam(params.url) ?? '');
  const [showAdvanced, setShowAdvanced] = useState(() => Boolean(firstParam(params.agentId)));
  const [token, setToken] = useState(() => firstParam(params.token) ?? '');
  const [sessionKey, setSessionKey] = useState(() => firstParam(params.sessionKey) ?? 'agent:main:main');
  const [agentId, setAgentId] = useState(() => firstParam(params.agentId) ?? 'main');
  const [saving, setSaving] = useState(false);
  const [identified, setIdentified] = useState<GatewayIdentity | null>(null);
  const [accessNote, setAccessNote] = useState<string | null>(null);
  const [accessStatus, setAccessStatus] = useState<AccessRequestResult['status'] | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setAccessNote(null);
    setAccessStatus(null);
    setSaveError(null);
    try {
      // 1. Identify the gateway regardless of origin (manifest → fingerprints).
      const identity = await identifyGateway({ baseUrl: url });
      setIdentified(identity);

      // 2. Request access through the kind-appropriate handshake.
      if (identity.kind === 'openclaw' || identity.kind === 'custom') {
        const result = await requestGatewayAccess({ baseUrl: url, identity, token: token || undefined });
        setAccessStatus(result.status);
        if (result.status === 'granted' && result.token) setToken(result.token);
        if (result.status === 'pending-approval') setAccessNote(result.hint ?? 'Approval requested — approve this device on the gateway.');
        if (result.status === 'denied') {
          setAccessNote(result.reason);
          setSaving(false);
          return;
        }
        if (result.status === 'token-required') {
          setAccessNote(result.hint ?? 'This gateway requires a token.');
          setShowAdvanced(true);
          setSaving(false);
          return;
        }
      } else if (identity.auth.requiresToken && !token.trim()) {
        setAccessNote('This gateway requires an access token — paste it below to connect.');
        setShowAdvanced(true);
        setSaving(false);
        return;
      }

      // 3. Save the identified profile and connect through the kind's adapter.
      const discoverySource = url.includes('.ts.net') || url.startsWith('wss://') ? 'tailscale' : 'manual';
      const gateway = await addGateway({
        name,
        url,
        kind: identity.kind,
        token: token || undefined,
        sessionKey: showAdvanced ? sessionKey : undefined,
        agentId: showAdvanced ? agentId : undefined,
        discoverySource,
      });
      await connectGateway(gateway);
      router.replace('/chat');
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  function handleUrlChange(text: string) {
    setUrl(text);
    setIdentified(null);
    setAccessNote(null);
    setAccessStatus(null);
  }

  return (
    <Screen>
      <KeyboardAvoidingView
        style={styles.keyboard}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        {/* Six fields plus a transport card outgrow the viewport once the
            keyboard is up, and a bottom-anchored fixed block puts Save out of
            reach with nothing to scroll. */}
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          showsVerticalScrollIndicator={false}>
        <Card padding={Spacing.four} style={styles.sheet}>
          <Text color="secondary">
            Usually you do not need this — Versutus connects automatically via Tailscale. Use manual add only for
            custom URLs or tokens.
          </Text>

          <Field label="Name" value={name} onChangeText={setName} />
          <Field
            label="Gateway URL"
            value={url}
            onChangeText={handleUrlChange}
            placeholder="http://yourpc.tailnet.ts.net:8642 or ws://host:8642/openclaw"
            autoCapitalize="none"
          />

          {url.trim() ? <TransportSecurityCard url={url} /> : null}

          {identified ? (
            <View style={styles.identified}>
              <Text variant="caption" color="accent">
                Identified: {identified.kindLabel}
                {identified.version ? ` v${identified.version}` : ''}
                {identified.auth.schemes.length > 0
                  ? ` · ${identified.auth.schemes.join(' / ')} auth`
                  : ''}
                {identified.source === 'manifest' ? ' · manifest' : ''}
              </Text>
              {identified.capabilities && identified.capabilities.length > 0 ? (
                <Text variant="caption" color="secondary">
                  {identified.capabilities.join(' · ')}
                </Text>
              ) : null}
            </View>
          ) : null}

          {accessNote ? (
            <Text variant="caption" color={accessStatus === 'denied' ? 'accentWarm' : 'secondary'}>
              {accessNote}
            </Text>
          ) : null}

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

          {saveError ? (
            <ErrorCard
              {...humanizeGatewayError(saveError)}
              onRetry={() => void handleSave()}
            />
          ) : null}

          <Button
            label="Save & connect"
            onPress={() => void handleSave()}
            disabled={saving || !url.trim()}
          />
        </Card>
        </ScrollView>
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
  },
  scroll: {
    // flexGrow keeps the sheet bottom-anchored when it fits, and lets it
    // scroll rather than overflow when it does not.
    flexGrow: 1,
    justifyContent: 'flex-end',
    paddingBottom: Spacing.four,
  },
  sheet: {
    margin: Spacing.four,
    borderRadius: Radius.xl,
    gap: Spacing.three,
  },
  field: {
    gap: Spacing.one,
  },
  identified: {
    gap: Spacing.half,
  },
  advanced: {
    gap: Spacing.two,
  },
});
