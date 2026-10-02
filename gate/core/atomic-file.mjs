import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';

// Windows keeps a just-written (or just-read) file briefly locked, so the
// rename over the target can fail with EPERM/EBUSY. A tight reader loop
// holds the file open often enough to starve a short retry, so the policy is
// patient: up to 25 attempts with 10-40 ms jittered waits (worst case
// ~960 ms, under 1 s). A rename that keeps failing under contention must
// not turn into a 500 for the caller.
const RENAME_ATTEMPTS = 25;
const RENAME_RETRY_MIN_MS = 10;
const RENAME_RETRY_JITTER_MS = 30;

// The same sharing-violation codes the rename retry waits out: a reader that
// lands while another handle still has the file open (indexer, AV, a just-
// finished write) gets EBUSY/EPERM/EACCES, which is not a damaged file.
const TRANSIENT_LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
// Shorter than the rename loop: a reader that waits a full second on a
// persistently unreadable file would stall every authenticated request.
const READ_LOCK_ATTEMPTS = 8;

async function renameWithRetry(tmpPath, targetPath) {
  let lastError;
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
    try {
      await rename(tmpPath, targetPath);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY') throw error;
      if (attempt < RENAME_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MIN_MS + Math.random() * RENAME_RETRY_JITTER_MS));
      }
    }
  }
  throw lastError;
}

/**
 * Write `data` to `path` atomically: land it in a sibling tmp file first,
 * then rename over the target. A reader (or a crash) never observes a
 * half-written file — it sees either the old content or the new content.
 */
export async function writeFileAtomic(path, data, { mode, encoding } = {}) {
  const tmpPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmpPath, data, { encoding, mode });
    await renameWithRetry(tmpPath, path);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * True when a read failed because the file is briefly locked, not because
 * its contents are damaged. Callers that treat `corrupt` as "empty list"
 * must not do that for these codes.
 */
export function isTransientLockError(error) {
  return TRANSIENT_LOCK_CODES.has(error?.code);
}

/**
 * Read and parse a JSON file, telling the three outcomes apart: the file is
 * absent (`missing`), it parsed (`ok`), or it exists but is unreadable or
 * unparseable (`corrupt`, with the reason). Callers must not treat a
 * corrupt file as an empty one — that would silently drop every record.
 *
 * A Windows sharing violation is waited out with the same patient policy as
 * `renameWithRetry` before it is called corrupt: the file is fine, just
 * briefly locked.
 */
export async function readJsonFile(path) {
  let text;
  let lastError;
  for (let attempt = 0; attempt < READ_LOCK_ATTEMPTS; attempt += 1) {
    try {
      text = await readFile(path, 'utf8');
      lastError = null;
      break;
    } catch (error) {
      if (error?.code === 'ENOENT') return { state: 'missing' };
      lastError = error;
      if (!isTransientLockError(error) || attempt === READ_LOCK_ATTEMPTS - 1) {
        return { state: 'corrupt', error };
      }
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MIN_MS + Math.random() * RENAME_RETRY_JITTER_MS));
    }
  }
  if (lastError) return { state: 'corrupt', error: lastError };
  try {
    return { state: 'ok', value: JSON.parse(text) };
  } catch (error) {
    return { state: 'corrupt', error };
  }
}
