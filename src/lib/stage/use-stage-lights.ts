import { useState } from 'react';

import { useCrestFleetVersion } from '@/hooks/use-crest-fleet';

import { stageLightsFor, stageRoomKey, type StageLights, type StageRoom } from './lamp';

/**
 * The lights for a room, recomputed only when the room itself changes — a
 * screen builds its `room` inline on every render, and a new object must not
 * restart the crossfade. The fleet version catches a crest tone that moved
 * when the team's inventory arrived.
 */
export function useStageLights(room: StageRoom | undefined): StageLights {
  // Subscribed: the room relights in its assigned tone when the fleet lands.
  const fleet = useCrestFleetVersion();
  const key = `${stageRoomKey(room)}|${fleet}`;
  const [memo, setMemo] = useState(() => ({ key, lights: stageLightsFor(room) }));
  if (memo.key !== key) {
    const next = { key, lights: stageLightsFor(room) };
    setMemo(next);
    return next.lights;
  }
  return memo.lights;
}
