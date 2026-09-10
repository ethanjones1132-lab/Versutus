// ─── The device side of a transcript share ────────────────────────────────
// The one seam that touches `expo-file-system` and `expo-sharing`, kept off
// the pure rules in `transcript-export.ts` so those can be tested without a
// device. The Command history section composes the two: it composes the
// Markdown, names the file with the export module's own fold, and asks here.
//
// The file never goes anywhere by itself. `shareAsync` opens the platform's
// own sheet on it and the operator decides what to do with it — nothing is
// uploaded, sent to a gateway, or hosted. The file is the share.

import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/**
 * Whether this device has a share sheet to open. A platform without the native
 * module (web) throws rather than answering, and a question that cannot be
 * answered is `false` — the surface then draws no control that cannot finish.
 */
export async function transcriptShareAvailable(): Promise<boolean> {
  try {
    return await Sharing.isAvailableAsync();
  } catch {
    return false;
  }
}

/**
 * Write the composer's Markdown to a file in the cache directory under the
 * name it is handed, then open the system share sheet on it. Answers whether
 * the sheet was opened, so the surface can tell a share from a refusal rather
 * than buzzing over one that never appeared; a write or a sheet that throws is
 * the same `false`, and a device with no sheet writes no file at all.
 *
 * The cache directory is deliberate: this file is scratch for one share, and
 * the platform may reclaim it. Nothing here is durable storage.
 */
export async function shareTranscriptFile(
  fileName: string,
  markdown: string,
): Promise<boolean> {
  try {
    if (!(await Sharing.isAvailableAsync())) return false;
    const file = new File(Paths.cache, fileName);
    file.write(markdown);
    await Sharing.shareAsync(file.uri, {
      mimeType: 'text/markdown',
      UTI: 'net.daringfireball.markdown',
    });
    return true;
  } catch {
    return false;
  }
}
