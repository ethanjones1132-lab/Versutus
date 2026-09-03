import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { CapabilitiesSection } from '@/components/gateway/capabilities-section';
import { RpcMethodsSection } from '@/components/gateway/rpc-methods-section';
import { ToolsetsSection } from '@/components/gateway/toolsets-section';
import { EnvironmentsSection } from '@/components/gateway/environments-section';
import { GatewayManagementSection } from '@/components/gateway/gateway-management-section';
import { ProvidersSection } from '@/components/gateway/providers-section';
import { Card, Chip, Screen, SegmentedControl, Text } from '@/components/ui';
import { useGateway } from '@/context/gateway-provider';
import { Spacing } from '@/constants/tokens';

type Section = 'providers' | 'environments' | 'capabilities' | 'management';

const SECTIONS = [
  { key: 'providers' as const, label: 'Providers' },
  { key: 'environments' as const, label: 'CLI' },
  { key: 'capabilities' as const, label: 'Capabilities' },
  { key: 'management' as const, label: 'Manage' },
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
  // Show what is actually selected. This used to fall back to `backends[0]`,
  // which drew the Claude Code chip as chosen while the provider held
  // undefined — so the screen disagreed with the thing doing the routing, and
  // the operator had to tap a chip that already looked active. The provider
  // adopts a default on connect now, so there is a real value to show.
  const activeBackendId = selectedBackendId;

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

        {section === 'capabilities' ? (
          <>
            <Text variant="caption">
              Instances of non-provider capability kinds. Providers are managed on the Providers
              tab — the registry no longer creates them, so a provider has exactly one home.
            </Text>
            <CapabilitiesSection />
            <ToolsetsSection />
            <RpcMethodsSection />
          </>
        ) : null}

        {section === 'management' ? (
          <>
            <Text variant="caption">
              Saved gateways, auto-connect, and local discovery.
            </Text>
            <GatewayManagementSection />
          </>
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
