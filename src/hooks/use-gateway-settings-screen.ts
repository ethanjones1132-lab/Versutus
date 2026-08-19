import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';

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
  const [deleteCandidateId, setDeleteCandidateId] = useState<string | null>(null);

  const handleConnect = useCallback(
    async (gatewayId: string) => {
      const gateway = gateways.find((item) => item.id === gatewayId);
      if (!gateway) return;
      await connectGateway(gateway);
      router.push('/chat');
    },
    [connectGateway, gateways, router],
  );

  const handleDelete = useCallback((gatewayId: string) => {
    setDeleteCandidateId(gatewayId);
  }, []);

  const confirmDelete = useCallback(() => {
    if (deleteCandidateId) {
      void deleteGateway(deleteCandidateId);
    }
    setDeleteCandidateId(null);
  }, [deleteCandidateId, deleteGateway]);

  const cancelDelete = useCallback(() => {
    setDeleteCandidateId(null);
  }, []);

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

  const deleteCandidate = deleteCandidateId
    ? gateways.find((item) => item.id === deleteCandidateId) ?? null
    : null;

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
    deleteCandidate,
    confirmDelete,
    cancelDelete,
    router,
  };
}
