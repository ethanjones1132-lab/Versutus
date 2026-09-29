import { useEffect, useSyncExternalStore } from 'react';

import { botLookIn, type BotLook } from '@/lib/avatar/look';
import { ensureBotLooksLoaded } from '@/lib/avatar/look-store';
import { crestFleetSnapshot, crestLooksSnapshot, subscribeCrestFleet } from '@/lib/bot-avatar';

/**
 * A Bot's whole look — form, face, colour — under the fleet's assignment and
 * the operator's choices. Both are read as values and handed to a pure
 * function (see useBotCrest for why), and the stored choices are read the
 * first time any figure is drawn.
 */
export function useBotLook(botId: string, name?: string): BotLook {
  const fleet = useSyncExternalStore(subscribeCrestFleet, crestFleetSnapshot, crestFleetSnapshot);
  const looks = useSyncExternalStore(subscribeCrestFleet, crestLooksSnapshot, crestLooksSnapshot);
  useEffect(() => {
    void ensureBotLooksLoaded();
  }, []);
  return botLookIn(fleet, looks, botId, name);
}
