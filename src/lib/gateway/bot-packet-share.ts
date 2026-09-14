// ─── The device side of a Bot handoff packet ───────────────────────────────
// The export half of D6, riding the `transcript-share.ts` one-seam pattern:
// this is the only file that touches `expo-file-system` and `expo-sharing`
// for packets, so the pure packet fold in `bot-packet.ts` stays testable
// without a device. The Bot detail sheet composes the two: it builds the
// packet, names the file with the packet module's own fold, and asks here.
//
// The file never goes anywhere by itself — `shareAsync` opens the platform's
// own sheet on it and the operator decides. Nothing is uploaded, sent to a
// gateway, or hosted. The file is the share.

import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/**
 * Whether this device has a share sheet to open. A platform without the
 * native module (web) throws rather than answering, and a question that
 * cannot be answered is `false` — the surface then draws no control that
 * cannot finish.
 */
export async function botPacketShareAvailable(): Promise<boolean> {
  try {
    return await Sharing.isAvailableAsync();
  } catch {
    return false;
  }
}

/**
 * Write the packet's JSON to a file in the cache directory under the name it
 * is handed, then open the system share sheet on it. Answers whether the
 * sheet was opened, so the surface can tell a share from a refusal; a write
 * or a sheet that throws is the same `false`, and a device with no sheet
 * writes no file at all.
 *
 * The cache directory is deliberate: this file is scratch for one share, and
 * the platform may reclaim it. Nothing here is durable storage.
 */
export async function shareBotPacketFile(
  fileName: string,
  json: string,
): Promise<boolean> {
  try {
    if (!(await Sharing.isAvailableAsync())) return false;
    const file = new File(Paths.cache, fileName);
    file.write(json);
    await Sharing.shareAsync(file.uri, {
      // application/json with the .json uti: the sheet offers somewhere the
      // packet can actually land (Files, another device), not a markdown handler.
      mimeType: 'application/json',
      UTI: 'public.json',
    });
    return true;
  } catch {
    return false;
  }
}
