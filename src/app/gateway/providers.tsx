import { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView } from 'react-native';

import { OauthProgressSheet } from '@/components/gateway/oauth-progress-sheet';
import { ProviderCard } from '@/components/gateway/provider-card';
import { ProviderEditor } from '@/components/gateway/provider-editor';
import { Screen, Text } from '@/components/ui';
import { useGateway } from '@/context/gateway-provider';
import { createProviderClient } from '@/lib/gateway/provider-client';
import type { ProviderSnapshot } from '@/lib/gateway/provider-types';

export default function ProvidersScreen() {
  const { status, gatewayRequest } = useGateway();
  const client = createProviderClient(gatewayRequest);
  const [providers, setProviders] = useState<ProviderSnapshot[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [oauthMessage, setOauthMessage] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (status !== 'connected') {
      setError('Connect to a Gate to manage providers.');
      return;
    }
    try {
      const listed = await gatewayRequest<{ providers?: ProviderSnapshot[] }>('GET /v1/providers').catch(async () => {
        const viaRpc = await gatewayRequest<ProviderSnapshot[]>('providers.list').catch(() => []);
        return { providers: viaRpc };
      });
      setProviders(listed.providers ?? []);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [gatewayRequest, status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refreshOne(id: string) {
    const snapshot = await client.refreshCatalog(id);
    setProviders((current) => current.map((item) => (item.id === id ? snapshot : item)));
  }

  return (
    <Screen>
      <ScrollView>
        <Text variant="title">Providers</Text>
        {error ? <Text variant="caption">{error}</Text> : null}
        {providers.map((snapshot) => (
          <ProviderCard
            key={snapshot.id}
            snapshot={snapshot}
            onCheck={() => void client.check(snapshot.id).then((next) => setProviders((current) => current.map((item) => (item.id === snapshot.id ? next : item))))}
            onRefresh={() => void refreshOne(snapshot.id)}
            onDisconnect={() => void client.disconnect(snapshot.id).then(load)}
            onDisable={() => void gatewayRequest('providers.update', { id: snapshot.id, enabled: false }).then(load)}
            onDelete={() => void client.remove(snapshot.id).then(load)}
            onSetKey={() => setEditingId(snapshot.id)}
            onAuthorize={() => {
              setOauthMessage('Continue authorization in the desktop browser.');
              void client.beginAuth(snapshot.id);
            }}
          />
        ))}
        {editingId ? (
          <ProviderEditor
            onSubmit={(value) => {
              void client.setApiKey(editingId, value).then(() => {
                setEditingId(null);
                void load();
              });
            }}
          />
        ) : null}
      </ScrollView>
      <OauthProgressSheet visible={!!oauthMessage} message={oauthMessage} onClose={() => setOauthMessage('')} />
    </Screen>
  );
}
