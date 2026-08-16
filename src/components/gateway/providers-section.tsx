import { useCallback, useEffect, useMemo, useState } from 'react';

import { OauthProgressSheet } from '@/components/gateway/oauth-progress-sheet';
import { ProviderCard } from '@/components/gateway/provider-card';
import { ProviderKeySheet } from '@/components/gateway/provider-key-sheet';
import { ProviderRegistrationForm } from '@/components/gateway/provider-registration-form';
import { Button, EmptyState, ErrorCard, Skeleton, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { createProviderClient, type CreateProviderInput } from '@/lib/gateway/provider-client';
import type { ProviderProfile, ProviderSnapshot } from '@/lib/gateway/provider-types';

/** Model providers the Gate owns: registration, credentials, catalogs. */
export function ProvidersSection() {
  const { status, gatewayRequest } = useGateway();
  const client = useMemo(() => createProviderClient(gatewayRequest), [gatewayRequest]);
  const [providers, setProviders] = useState<ProviderSnapshot[]>([]);
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [registering, setRegistering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [oauthMessage, setOauthMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (status !== 'connected') {
      setError('Connect to a Gate to manage providers.');
      setLoaded(true);
      return;
    }
    try {
      setProviders(await client.list());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
    // A Gate predating providers.profiles.list still lists fine — it just
    // cannot offer registration, so this must not clear the list.
    try {
      setProfiles(await client.listProfiles());
    } catch {
      setProfiles([]);
    } finally {
      setLoaded(true);
    }
  }, [client, status]);

  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  async function register(input: CreateProviderInput) {
    setBusy(true);
    setError(null);
    try {
      await client.create(input);
      setRegistering(false);
      await load();
      // A provider without a key is inert, so go straight to the prompt.
      setEditingId(input.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  /** Save the key, then prove it works rather than leaving it to be discovered later. */
  async function saveKey(id: string, value: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await client.setApiKey(id, value);
      const snapshot = await client.check(id);
      if (snapshot.readiness?.state === 'ready') {
        setNotice(`${snapshot.label} is ready.`);
      } else {
        setError(
          `${snapshot.label}: ${snapshot.readiness?.message ?? snapshot.readiness?.state ?? 'not ready'}`,
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setEditingId(null);
      setBusy(false);
      void load();
    }
  }

  const canRegister = status === 'connected' && profiles.length > 0;

  return (
    <>
      {error ? (
        <ErrorCard
          cause={error}
          affected="Providers on this Gate"
          next={status === 'connected' ? 'Retry, or check the Gate log for the failing call.' : 'Connect to the Gate first.'}
          onRetry={() => void load()}
        />
      ) : null}
      {notice ? <Text variant="caption">{notice}</Text> : null}

      {canRegister && !registering ? (
        <Button label="Add provider" onPress={() => setRegistering(true)} />
      ) : null}

      {registering ? (
        <ProviderRegistrationForm
          profiles={profiles}
          busy={busy}
          error={error}
          onSubmit={(input) => void register(input)}
          onCancel={() => { setRegistering(false); setError(null); }}
        />
      ) : null}

      {!loaded && status === 'connected' ? (
        <>
          <Skeleton height={96} style={{ marginBottom: Spacing.three }} />
          <Skeleton height={96} />
        </>
      ) : null}

      {loaded && providers.length === 0 && !registering && status === 'connected' ? (
        <EmptyState
          icon={{ ios: 'square.stack.3d.up', android: 'layers', web: 'layers' }}
          title="No providers yet"
          description="Register a provider to give this Gate a model catalog."
          actionLabel={canRegister ? 'Add provider' : undefined}
          onAction={canRegister ? () => setRegistering(true) : undefined}
        />
      ) : null}

      {providers.map((snapshot) => (
        <ProviderCard
          key={snapshot.id}
          snapshot={snapshot}
          onCheck={() => void client.check(snapshot.id).then((next) => setProviders((current) => current.map((item) => (item.id === snapshot.id ? next : item))))}
          onRefresh={() => void client.refreshCatalog(snapshot.id).then((next) => setProviders((current) => current.map((item) => (item.id === snapshot.id ? next : item))))}
          onDisconnect={() => void client.disconnect(snapshot.id).then(load)}
          onDisable={() => void client.update(snapshot.id, { enabled: false }).then(load)}
          onDelete={() => void client.remove(snapshot.id).then(load)}
          onSetKey={() => setEditingId(snapshot.id)}
          onAuthorize={() => {
            setOauthMessage('Continue authorization in the desktop browser.');
            void client.beginAuth(snapshot.id);
          }}
          onEnable={() => void client.update(snapshot.id, { enabled: true }).then(load)}
        />
      ))}

      <ProviderKeySheet
        visible={editingId !== null}
        label={providers.find((provider) => provider.id === editingId)?.label ?? editingId ?? ''}
        busy={busy}
        onSubmit={(value) => { if (editingId) void saveKey(editingId, value); }}
        onClose={() => setEditingId(null)}
      />

      <OauthProgressSheet visible={!!oauthMessage} message={oauthMessage} onClose={() => setOauthMessage('')} />
    </>
  );
}
