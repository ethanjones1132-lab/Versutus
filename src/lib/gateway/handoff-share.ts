// ─── The device side of a Bot handoff export ──────────────────────────────
// D6's export seam, kept off the pure `handoff.ts` so the packet shape and its
// memory/credentials exclusion can be tested without a device. The file is
// scratch for one share; `shareAsync` opens the platform's own sheet and the
// operator decides what to do with it. Nothing is uploaded or sent anywhere.

import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { buildBotHandoff, handoffFileName, type BotHandoffSource } from '@/lib/gateway/handoff';

/** Whether this device can open a share sheet for the exported packet. */
export async function handoffShareAvailable(): Promise<boolean> {
  try {
    return await Sharing.isAvailableAsync();
  } catch {
    return false;
  }
}

/** Write the packet to the cache and open the share sheet. */
export async function shareBotHandoff(source: BotHandoffSource): Promise<boolean> {
  try {
    if (!(await Sharing.isAvailableAsync())) return false;
    const packet = buildBotHandoff(source);
    const file = new File(Paths.cache, handoffFileName(packet));
    file.write(JSON.stringify(packet, null, 2));
    await Sharing.shareAsync(file.uri, {
      mimeType: 'application/json',
      UTI: 'public.json',
    });
    return true;
  } catch {
    return false;
  }
}
