import { useEffect } from 'react';

import { useGateway } from '@/context/gateway-provider';
import { signalConnection } from '@/lib/stage/signals';

/**
 * Tells the stage how the Gate is doing, from inside the provider tree, so
 * every screen's lamp dims together when the Gate goes offline. No Gate at
 * all (first run) leaves the lamp at full: an empty house is not an outage.
 */
export function StageSignalBridge() {
  const { status, gateways } = useGateway();
  const connection = gateways.length === 0 ? undefined : status;
  useEffect(() => {
    signalConnection(connection);
  }, [connection]);
  return null;
}
