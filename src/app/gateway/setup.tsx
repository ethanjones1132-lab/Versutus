import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { CapabilitiesSection } from '@/components/gateway/capabilities-section';
import { GatewayIdentitySection } from '@/components/gateway/gateway-identity-section';
import { RpcMethodsSection } from '@/components/gateway/rpc-methods-section';
import { ToolsetsSection } from '@/components/gateway/toolsets-section';
import { EnvironmentsSection } from '@/components/gateway/environments-section';
import { GatewayManagementSection } from '@/components/gateway/gateway-management-section';
import { NotificationsSection } from '@/components/gateway/notifications-section';
import { ProvidersSection } from '@/components/gateway/providers-section';
import { Card, Chip, Screen, SegmentedControl, Text } from '@/components/ui';
import { useGateway } from '@/context/gateway-provider';
import { backendChipLabel } from '@/lib/gateway/backend-freshness';
import { gateSetupReach } from '@/lib/gateway/gate-setup-reach';
import { Spacing } from '@/constants/tokens';

type Section = 'providers' | 'environments' | 'capabilities' | 'notifications' | 'management';

const SECTIONS = [
  { key: 'providers' as const, label: 'Providers' },
  { key: 'environments' as const, label: 'CLI' },
  { key: 'capabilities' as const, label: 'Capabilities' },
  { key: 'notifications' as const, label: 'Notifications' },
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
  const { backends, selectedBackendId, selectBackend, activeGateway, activeManifest, status } = useGateway();
  const reach = gateSetupReach({ status, kind: activeGateway?.kind, hasManifest: activeManifest !== null });
  // The Gate-only tabs speak the Gate's RPCs; on anything else they would
  // only stack refusals, so one card says what this connection is instead.
  const gateOnly = section !== 'management' && (reach === 'not-a-gate' || reach === 'reaching-gate');
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

        <GatewayIdentitySection />

        {backends.length > 0 ? (
          <Card padding={Spacing.three} style={styles.card}>
            <Text variant="headline">Chat backend</Text>
            <Text variant="caption">
              Conversations run inside this environment, using its own sessions, models and tools.
            </Text>
            <View style={styles.row}>
              {backends.map((backend) => (
                <Chip
                  key={backend.id}
                  label={backendChipLabel(backend)}
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
        />

        {gateOnly ? (
          <Card padding={Spacing.three} style={styles.card}>
            <Text variant="headline">{reach === 'reaching-gate' ? 'Reaching the Gate…' : 'This is not a Versutus Gate'}</Text>
            <Text variant="caption" color="secondary">
              {reach === 'reaching-gate'
                ? "The Gate's manifest has not answered yet. This tab opens as soon as it does."
                : `${activeGateway?.name ?? 'This gateway'} is a ${
                    activeGateway?.kind === 'openclaw' ? 'OpenClaw' : 'Hermes'
                  } server. Providers, CLI environments, capabilities and push are served by a Versutus Gate — connect to the Gate (port 8760) on this PC to manage them.`}
            </Text>
          </Card>
        ) : null}

        {section === 'providers' && !gateOnly ? (
          <View style={styles.panel}>
            <Text variant="caption" color="secondary">
              Model providers the Gate owns — it holds the key and the catalog.
            </Text>
            <ProvidersSection />
          </View>
        ) : null}

        {section === 'environments' && !gateOnly ? (
          <View style={styles.panel}>
            <Text variant="caption" color="secondary">
              CLI agents attached to this Gate. They never receive your provider keys.
            </Text>
            <EnvironmentsSection />
          </View>
        ) : null}

        {section === 'capabilities' && !gateOnly ? (
          <View style={styles.panel}>
            <Text variant="caption" color="secondary">
              Instances of non-provider capability kinds. Providers are managed on the Providers
              tab — the registry no longer creates them, so a provider has exactly one home.
            </Text>
            <CapabilitiesSection />
            <ToolsetsSection />
            <RpcMethodsSection />
          </View>
        ) : null}

        {section === 'management' ? (
          <View style={styles.panel}>
            <Text variant="caption" color="secondary">
              Saved gateways, auto-connect, and local discovery.
            </Text>
            <GatewayManagementSection />
          </View>
        ) : null}

        {section === 'notifications' && !gateOnly ? (
          <View style={styles.panel}>
            <Text variant="caption" color="secondary">
              Push notifications from this Gate — runs, approvals, replies and routines, with the app
              backgrounded or killed.
            </Text>
            <NotificationsSection />
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: Spacing.four, gap: Spacing.three, paddingBottom: Spacing.six },
  panel: { gap: Spacing.one },
  card: { gap: Spacing.two },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
});
