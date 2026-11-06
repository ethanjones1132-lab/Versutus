import { useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';

import { useGateway } from '@/context/gateway-provider';
import { useGatewayDiscovery } from '@/hooks/use-gateway-discovery';
import { useGatewayReachability } from '@/hooks/use-gateway-reachability';
import type { GatewayProfile } from '@/lib/gateway/types';

export type ConnectOutcome = { ok: true } | { ok: false; error: unknown };

export function gatewayRemovalMessage(
  gatewayName: string,
  queueRead: boolean,
  queuedCount: number | null,
): string {
  const base = `${gatewayName} will stay available if discovered again.`;
  if (!queueRead) return `${base} The unsent message count could not be read.`;
  if (!queuedCount) return base;
  return `${base} ${queuedCount} unsent message${queuedCount === 1 ? '' : 's'} will be deleted with this gateway.`;
}

/** The profile ids `removeGateway(id)` deletes: the profile and its provider child profiles. */
export function gatewayIdsRemovedWith(
  gatewayId: string,
  gateways: readonly Pick<GatewayProfile, 'id' | 'parentId'>[],
): Set<string> {
  const ids = new Set<string>([gatewayId]);
  for (const gateway of gateways) if (gateway.parentId === gatewayId) ids.add(gateway.id);
  return ids;
}

/**
 * Connect, and open the chat only over a connection that answered.
 *
 * `connectGateway` rethrows an auth refusal on purpose (gateway-provider.tsx
 * `attachClient`), so awaiting it with nothing to catch turned a gateway whose
 * token the Gate has rotated into an unhandled rejection — and, in the version
 * that did navigate, a chat screen with no gateway behind it. The refusal is
 * handed back for the caller to name; the navigation is not.
 */
export async function connectThenOpenChat(
  gateway: GatewayProfile,
  connectGateway: (gateway: GatewayProfile) => Promise<void>,
  openChat: () => void,
): Promise<ConnectOutcome> {
  try {
    await connectGateway(gateway);
  } catch (error) {
    return { ok: false, error };
  }
  openChat();
  return { ok: true };
}

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
  // A refused connect and a remove whose storage write failed both used to
  // fire a promise nobody handled: no navigation, no dismissal, and no word on
  // screen. The screen's own surface carries both.
  const [connectFailure, setConnectFailure] = useState<unknown>(null);
  const [discoveredSaveFailure, setDiscoveredSaveFailure] = useState<string | null>(null);
  const [deleteFailure, setDeleteFailure] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteQueueCount, setDeleteQueueCount] = useState<number | null>(0);
  const [deleteQueueRead, setDeleteQueueRead] = useState(true);
  const [deleteQueueReading, setDeleteQueueReading] = useState(false);
  // The in-flight write, in a ref: two taps inside one frame come off the same
  // rendered closure, and `setDeletePending` has not re-rendered anything yet,
  // so the state read alone cannot tell the second press from the first.
  const deletePendingRef = useRef(false);

  // A refused connect is a connection failure and follows the same rule as
  // every other one (stale-error.ts): a gateway that is answering has refused
  // nothing. Adjusted while rendering rather than in an effect — an effect that
  // clears state re-renders for nothing — so the provider's own auto-retry
  // after an auth refusal is enough to make this card go away on its own.
  const [failureStatus, setFailureStatus] = useState(status);
  if (status !== failureStatus) {
    setFailureStatus(status);
    if (status === 'connected') setConnectFailure(null);
  }

  const handleConnect = useCallback(
    async (gatewayId: string) => {
      const gateway = gateways.find((item) => item.id === gatewayId);
      if (!gateway) return;
      setConnectFailure(null);
      const outcome = await connectThenOpenChat(gateway, connectGateway, () =>
        router.push('/chat'),
      );
      if (!outcome.ok) setConnectFailure(outcome.error);
    },
    [connectGateway, gateways, router],
  );

  const handleDelete = useCallback(async (gatewayId: string) => {
    setDeleteFailure(null);
    setDeleteCandidateId(null);
    setDeleteQueueReading(true);
    try {
      // Loaded on demand: importing the queue store at module load pulls
      // AsyncStorage into every test that renders the settings screen.
      const { loadOfflineQueueFromStore } = await import('@/lib/gateway/session-persistence');
      const load = await loadOfflineQueueFromStore();
      setDeleteQueueRead(load.read);
      // The delete cascades to provider child profiles (`removeGateway`), so
      // their queued sends are deleted too and belong in the count.
      const removed = gatewayIdsRemovedWith(gatewayId, gateways);
      setDeleteQueueCount(load.read ? load.items.filter((item) => removed.has(item.gatewayId)).length : null);
      setDeleteCandidateId(gatewayId);
    } catch {
      setDeleteQueueRead(false);
      setDeleteQueueCount(null);
      setDeleteCandidateId(gatewayId);
    } finally {
      setDeleteQueueReading(false);
    }
  }, [gateways]);

  const confirmDelete = useCallback(async () => {
    const id = deleteCandidateId;
    // A second press while the write is in flight is not a second remove — read
    // from a ref, because two taps in one frame share this closure.
    if (!id || deletePendingRef.current) return;
    deletePendingRef.current = true;
    setDeletePending(true);
    setDeleteFailure(null);
    try {
      await deleteGateway(id);
      setDeleteCandidateId(null);
    } catch (error) {
      // The profile is still saved, so the sheet stays up and says why
      // instead of dismissing as if the removal had worked.
      setDeleteFailure(error instanceof Error ? error.message : String(error));
    } finally {
      deletePendingRef.current = false;
      setDeletePending(false);
    }
  }, [deleteCandidateId, deleteGateway]);

  const cancelDelete = useCallback(() => {
    setDeleteCandidateId(null);
    setDeleteFailure(null);
  }, []);

  const clearConnectFailure = useCallback(() => setConnectFailure(null), []);

  const handleAddDiscovered = useCallback(
    async (beaconId: string) => {
      const beacon = discovery.gateways.find((item) => item.id === beaconId);
      if (!beacon) return;
      setDiscoveredSaveFailure(null);
      setConnectFailure(null);
      let profile: GatewayProfile;
      try {
        profile = await addGateway({
          name: beacon.name,
          url: beacon.url,
          tlsFingerprint: beacon.tlsFingerprint,
          discoverySource: beacon.source === 'local' ? 'local' : 'tailscale',
        });
      } catch (error) {
        setDiscoveredSaveFailure(error instanceof Error ? error.message : String(error));
        return;
      }
      const outcome = await connectThenOpenChat(profile, connectGateway, () =>
        router.push('/chat'),
      );
      if (!outcome.ok) setConnectFailure(outcome.error);
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
    connectFailure,
    clearConnectFailure,
    discoveredSaveFailure,
    deleteFailure,
    deletePending,
    deleteQueueCount,
    deleteQueueRead,
    deleteQueueReading,
    router,
  };
}
