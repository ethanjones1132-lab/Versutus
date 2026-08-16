import { useState } from 'react';
import { Link, type Href } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';

import { EnvironmentsSection } from '@/components/gateway/environments-section';
import { ProvidersSection } from '@/components/gateway/providers-section';
import { Button, Card, Chip, Screen, SegmentedControl, Text } from '@/components/ui';
import { useGateway } from '@/context/gateway-provider';
import { Spacing } from '@/constants/tokens';

type Section = 'providers' | 'environments' | 'advanced';

const SECTIONS = [
  { key: 'providers' as const, label: 'Providers' },
  { key: 'environments' as const, label: 'CLI' },
  { key: 'advanced' as const, label: 'Advanced' },
];

/**
 * One home for everything you register on a Gate. Providers and CLI
 * environments previously lived on separate routes alongside a capability
 * editor that could also create providers — three destinations for one job,
 * and two ways to half-create the same thing.
 */
export default function GatewaySetupScreen() {
  const [section, setSection] = useState<Section>('providers');
  const { backends, selectedBackendId, selectBackend } = useGateway();
  const activeBackendId = selectedBackendId ?? backends[0]?.id;

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Text variant="title">Gate setup</Text>

        {backends.length > 0 ? (
          <Card padding={Spacing.three} style={styles.card}>
            <Text variant="title">Chat backend</Text>
            <Text variant="caption">
              Conversations run inside this environment, using its own sessions, models and tools.
            </Text>
            <View style={styles.row}>
              {backends.map((backend) => (
                <Chip
                  key={backend.id}
                  label={backend.label}
                  selected={backend.id === activeBackendId}
                  onPress={() => selectBackend(backend.id)}
                />
              ))}
            </View>
          </Card>
        ) : null}
        <SegmentedControl
          options={SECTIONS}
          selectedKey={section}
          onSelect={setSection}
          style={styles.tabs}
        />

        {section === 'providers' ? (
          <>
            <Text variant="caption">
              Model providers the Gate owns — it holds the key and the catalog.
            </Text>
            <ProvidersSection />
          </>
        ) : null}

        {section === 'environments' ? (
          <>
            <Text variant="caption">
              CLI agents attached to this Gate. They never receive your provider keys.
            </Text>
            <EnvironmentsSection />
          </>
        ) : null}

        {section === 'advanced' ? (
          <Card padding={Spacing.three} style={styles.card}>
            <Text variant="title">Capability registry</Text>
            <Text variant="caption">
              Instances of non-provider capability kinds. Providers are managed on the Providers
              tab — the registry no longer creates them, so a provider has exactly one home.
            </Text>
            <Link href={"/gateway/capabilities" as Href} asChild>
              <Button label="Open capability editor" variant="secondary" />
            </Link>
          </Card>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: Spacing.two, paddingBottom: Spacing.six },
  tabs: { marginBottom: Spacing.two },
  card: { gap: Spacing.two },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
});
