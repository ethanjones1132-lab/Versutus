import { useSyncExternalStore } from 'react';

import {
  botCrestIn,
  crestFleetSnapshot,
  crestLooksSnapshot,
  crestFleetVersion,
  subscribeCrestFleet,
  type BotCrest,
} from '@/lib/bot-avatar';

/**
 * The fleet's tone assignment, as a value a component re-renders on. A crest
 * drawn before the team's inventory arrived redraws in its assigned tone the
 * moment it lands, instead of keeping the tone it guessed.
 */
export function useCrestFleetVersion(): number {
  return useSyncExternalStore(subscribeCrestFleet, crestFleetVersion, crestFleetVersion);
}

/**
 * A Bot's crest under the fleet's current assignment. The assignment is read
 * as a value and handed to a pure function, so the crest visibly depends on
 * it: the React Compiler infers memo dependencies from what a computation
 * uses, and would otherwise keep the tone from before the fleet was known.
 */
export function useBotCrest(botId: string, name?: string): BotCrest {
  const fleet = useSyncExternalStore(subscribeCrestFleet, crestFleetSnapshot, crestFleetSnapshot);
  // A colour the operator chose is the crest's tone too.
  const looks = useSyncExternalStore(subscribeCrestFleet, crestLooksSnapshot, crestLooksSnapshot);
  return botCrestIn(fleet, botId, name, looks);
}
