import { useState } from 'react';

import { crestFleetVersion } from '@/lib/bot-avatar';

import { stageLightsFor, stageRoomKey, type StageLights, type StageRoom } from './lamp';

/**
 * The lights for a room, recomputed only when the room itself changes — a
 * screen builds its `room` inline on every render, and a new object must not
 * restart the crossfade. The fleet version catches a crest tone that moved
 * when the team's inventory arrived.
 */
export function useStageLights(room: StageRoom | undefined): StageLights {
  const key = `${stageRoomKey(room)}|${crestFleetVersion()}`;
  const [memo, setMemo] = useState(() => ({ key, lights: stageLightsFor(room) }));
  if (memo.key !== key) {
    const next = { key, lights: stageLightsFor(room) };
    setMemo(next);
    return next.lights;
  }
  return memo.lights;
}
