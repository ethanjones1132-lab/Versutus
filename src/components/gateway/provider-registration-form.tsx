import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Chip, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import type { CreateProviderInput } from '@/lib/gateway/provider-client';
import type { ProviderProfile } from '@/lib/gateway/provider-types';

/**
 * Register a provider from the phone. The profile choice supplies the vendor
 * shape (protocol, base URL, auth headers), so the operator supplies only an id
 * and — optionally — a self-hosted base URL. Everything else is assembled by
 * `buildProviderRegistration`, not typed into JSON on the desktop.
 */
export function ProviderRegistrationForm({
  profiles,
  onSubmit,
  onCancel,
  busy,
  error,
}: {
  profiles: ProviderProfile[];
  onSubmit: (input: CreateProviderInput) => void;
  onCancel: () => void;
  busy?: boolean;
  error?: string | null;
}) {
  const [profileId, setProfileId] = useState<string | null>(null);
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');

  const profile = profiles.find((item) => item.id === profileId) ?? null;

  /** Prefill from the chosen profile so the common case is a single field. */
  function chooseProfile(next: ProviderProfile) {
    setProfileId(next.id);
    setBaseUrl(next.defaultBaseUrl ?? '');
    setId((current) => current || next.id);
    setLabel((current) => current || next.label);
  }

  const idIsValid = /^[a-z0-9][a-z0-9-]*$/.test(id);
  const canSubmit = !!profile && idIsValid && !!baseUrl.trim() && !busy;

  return (
    <Card padding={Spacing.three} style={styles.card}>
      <Text variant="title">Add a provider</Text>
      {profiles.length === 0 ? (
        <Text variant="caption">
          This Gate advertises no provider profiles. Update the Gate to register providers from here.
        </Text>
      ) : (
        <>
          <Text variant="caption">Which service?</Text>
          <View style={styles.row}>
            {profiles.map((item) => (
              <Chip
                key={item.id}
                label={item.label}
                selected={item.id === profileId}
                onPress={() => chooseProfile(item)}
              />
            ))}
          </View>

          {profile ? (
            <>
              <Text variant="caption">Id — lowercase letters, numbers and hyphens</Text>
              <TextField
                value={id}
                onChangeText={setId}
                placeholder="nvidia"
                validationState={id.length === 0 ? 'default' : idIsValid ? 'valid' : 'invalid'}
              />
              <Text variant="caption">Display name</Text>
              <TextField value={label} onChangeText={setLabel} placeholder={profile.label} />
              <Text variant="caption">Base URL — change only for a self-hosted endpoint</Text>
              <TextField value={baseUrl} onChangeText={setBaseUrl} placeholder={profile.defaultBaseUrl} />
              <Text variant="caption">
                You&apos;ll add the API key next. It goes straight into the Gate vault.
              </Text>
            </>
          ) : null}
        </>
      )}

      {error ? <Text variant="caption">{error}</Text> : null}

      <View style={styles.actions}>
        <Button
          label={busy ? 'Registering…' : 'Register'}
          onPress={() => {
            if (!profile) return;
            onSubmit({ id, label, profile, baseUrl });
          }}
          disabled={!canSubmit}
        />
        <Button label="Cancel" variant="secondary" onPress={onCancel} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: Spacing.two, marginBottom: Spacing.three },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two, marginTop: Spacing.two },
});
