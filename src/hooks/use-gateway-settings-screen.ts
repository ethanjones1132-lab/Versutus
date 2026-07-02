import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { Alert } from 'react-native';

import { useGateway } from '@/context/gateway-provider';
import { useGatewayDiscovery } from '@/hooks/use-gateway-discovery';
import { useGatewayReachability } from '@/hooks/use-gateway-reachability';

export function useGatewaySettingsScreen() {
  const router = useRouter();
  const {
    gateways,
    activeGateway,
    status,
    statusDetail,
    settings,
    deviceId,
    connectGateway,
    deleteGateway,
    addGateway,
    setAutoConnect,
    refreshGateways,
  } = useGateway();
  const discovery = useGatewayDiscovery(true);
  const reachability = useGatewayReachability({ gateways, activeGateway, status });

  const handleConnect = useCallback(
    async (gatewayId: string) => {
      const gateway = gateways.find((item) => item.id === gatewayId);
      if (!gateway) return;
      await connectGateway(gateway);
      router.push('/chat');
    },
    [connectGateway, gateways, router],
  );

  const handleDelete = useCallback(
    (gatewayId: string) => {
      Alert.alert('Remove gateway?', 'Versutus can find it again automatically.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => void deleteGateway(gatewayId),
        },
      ]);
    },
    [deleteGateway],
  );

  const handleAddDiscovered = useCallback(
    async (beaconId: string) => {
      const beacon = discovery.gateways.find((item) => item.id === beaconId);
      if (!beacon) return;
      const profile = await addGateway({
        name: beacon.name,
        url: beacon.url,
        tlsFingerprint: beacon.tlsFingerprint,
        discoverySource: beacon.source === 'local' ? 'local' : 'tailscale',
      });
      await connectGateway(profile);
      router.push('/chat');
    },
    [addGateway, connectGateway, discovery.gateways, router],
  );

  return {
    gateways,
    activeGateway,
    status,
    statusDetail,
    settings,
    deviceId,
    discovery,
    reachability,
    setAutoConnect,
    refreshGateways,
    handleConnect,
    handleDelete,
    handleAddDiscovered,
    router,
  };
}
