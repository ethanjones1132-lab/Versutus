import type { SessionListEntry, SessionListRead } from './session-list';

/** Deliver a session read only while its selector and Gateway scope still own it. */
export async function readSessionList<T extends SessionListEntry>(
  read: () => Promise<T[]>,
  isCurrent: () => boolean,
  apply: (result: SessionListRead<T>) => void,
): Promise<void> {
  let result: SessionListRead<T>;
  try {
    result = { ok: true, sessions: await read() };
  } catch {
    result = { ok: false };
  }
  if (isCurrent()) apply(result);
}
