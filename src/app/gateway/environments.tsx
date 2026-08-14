import { useCallback, useEffect, useState } from 'react';
import { ScrollView } from 'react-native';

import { EnvironmentCard } from '@/components/gateway/environment-card';
import { EnvironmentRunSheet } from '@/components/gateway/environment-run-sheet';
import { Screen, Text } from '@/components/ui';
import { useGateway } from '@/context/gateway-provider';
import { createEnvironmentClient } from '@/lib/gateway/environment-client';
import type { EnvironmentRunEvent, EnvironmentSnapshot } from '@/lib/gateway/environment-types';

export default function EnvironmentsScreen() {
  const { status, gatewayRequest } = useGateway();
  const client = createEnvironmentClient(gatewayRequest);
  const [environments, setEnvironments] = useState<EnvironmentSnapshot[]>([]);
  const [events, setEvents] = useState<EnvironmentRunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (status !== 'connected') {
      setError('Connect to a Gate to manage CLI environments.');
      return;
    }
    try {
      const listed = await client.list();
      setEnvironments(listed);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [client, status]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Screen>
      <ScrollView>
        <Text variant="title">CLI environments</Text>
        {error ? <Text variant="caption">{error}</Text> : null}
        {environments.map((environment) => (
          <EnvironmentCard
            key={environment.id}
            environment={environment}
            onCheck={() => void client.check(environment.id).then(load)}
            onStart={() => void client.start(environment.id).then(load)}
            onStop={() => void client.stop(environment.id).then(load)}
            onRun={() => setEvents([{ runId: 'local', sequence: 1, timestamp: new Date().toISOString(), type: 'diagnostic', payload: { message: 'Start runs from the desktop Gate.' } }])}
          />
        ))}
      </ScrollView>
      <EnvironmentRunSheet visible={events.length > 0} events={events} onClose={() => setEvents([])} />
    </Screen>
  );
}
