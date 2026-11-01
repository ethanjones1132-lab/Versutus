// ─── Council mode: one prompt, several Bots ───────────────────────────────
// D7 (`FUTURE-ITEMS.md`): send one prompt to several Bots and compare the
// answers side by side, without shipping full group chats first. The fan-out
// is the part that must be right: one Bot failing is that Bot's column, never
// the whole council. The side-by-side view is the next slice; this module is
// the comparison data it draws.
//
// It is deliberately transport-free: the caller supplies a `send` per target,
// so the existing per-Bot send path stays the one place a message is sent.
// The transient room's own bookkeeping (naming it, remembering it, sweeping the
// ones a killed process left) is the one part that touches state, and it takes
// the storage seam as an argument rather than importing a native handle.

import { GatewayHttpError } from '@/lib/gateway/errors';

/** One Bot the council asks. */
export type CouncilTarget = { botId: string; label: string };

/** One Bot's place in the comparison. */
export type CouncilColumn = CouncilTarget &
  (
    | { state: 'answered'; text: string }
    | { state: 'silent' }
    | { state: 'failed'; error: string }
  );

/**
 * The Bots the council may ask: trimmed, deduped by Bot id, capped, in the
 * roster's own order. An empty or duplicate row is dropped rather than asked
 * twice.
 */
export function councilTargets(
  bots: { id: string; displayName?: string }[],
  limit = 3,
): CouncilTarget[] {
  const seen = new Set<string>();
  const targets: CouncilTarget[] = [];
  for (const bot of bots) {
    const botId = bot.id.trim();
    if (!botId || seen.has(botId)) continue;
    seen.add(botId);
    targets.push({ botId, label: bot.displayName?.trim() || botId });
    if (targets.length >= limit) break;
  }
  return targets;
}

/**
 * Ask every target the same prompt, in parallel, and keep the roster's order.
 * A rejected send is that target's failed column; a blank or absent answer is
 * that Bot's quiet column — the Gate's "nothing to add" — so a silence never
 * reads as an answer or an error.
 */
export async function runCouncil(
  prompt: string,
  targets: CouncilTarget[],
  send: (target: CouncilTarget, prompt: string) => Promise<string>,
): Promise<CouncilColumn[]> {
  return Promise.all(
    targets.map(async (target): Promise<CouncilColumn> => {
      try {
        const text = await send(target, prompt);
        if (!text.trim()) return { ...target, state: 'silent' };
        return { ...target, state: 'answered', text };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { ...target, state: 'failed', error: detail };
      }
    }),
  );
}

/** One line above the columns: how many answered, honestly. */
export function councilSummaryCopy(columns: CouncilColumn[]): string {
  const total = columns.length;
  if (total === 0) return 'No Bots to compare.';
  const answered = columns.filter((column) => column.state === 'answered').length;
  if (answered === total) return total === 2 ? 'Both answered.' : `All ${total} answered.`;
  return `${answered} of ${total} answered.`;
}

// ─── The view's send (slice 2) ────────────────────────────────────────────
// The app has no per-Bot "ask and await one answer" call, so the council
// reuses the one surface that does return text per Bot: the Gate's group
// round. It is one transient room per comparison, created and deleted around
// the send; `runCouncil` stays the ordering and failure-isolation layer over
// the replies that round returned.

export const COUNCIL_ROOM_PREFIX = 'Council · ';
const COUNCIL_ROOM_NAME_MAX = 50;
const COUNCIL_ROOM_TOKEN_CHARS = 4;

/**
 * A short label for the transient room a comparison runs in: the prefix plus a
 * random token.
 *
 * The room used to be named after the operator's prompt. Room creation and
 * deletion are paired inside one async function, so a round the OS kills
 * mid-flight (the documented Android background behaviour) left its room behind
 * with the operator's own words in its name, and nothing swept it. The prefix
 * keeps a council room recognisable in a Gate-side room list; the token keeps
 * two rounds apart without carrying anything the operator typed.
 */
export function councilRoomName(): string {
  const token = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(COUNCIL_ROOM_TOKEN_CHARS, '0');
  const name = `${COUNCIL_ROOM_PREFIX}${token}`;
  return name.slice(0, COUNCIL_ROOM_NAME_MAX);
}

/** Why the council is off on a gateway with no rooms — a capability, not an error. */
export function councilDisabledCopy(): string {
  return 'This gateway does not offer group rooms, so a council cannot compare Bots here.';
}

/**
 * What a prompt shared by several Bots may not be: a command. A `/` line
 * would go to every Bot as plain text — the council refuses it before any
 * send happens.
 */
export function councilPromptIssue(prompt: string): string | undefined {
  return prompt.trim().startsWith('/')
    ? 'The council sends one prompt, not a command — drop the leading slash.'
    : undefined;
}

// ─── One round's wall-clock bound ──────────────────────────────────────────
// The Gate fans a round out to every member and answers with the slowest one,
// so a single wedged Bot (a model still thinking, a profile stuck on the slow
// state.db) holds the whole request. The phone had no bound and no cancel at
// all: the screen stayed inert, saying it was still asking, for as long as the
// Gate's own turn limit allowed. The request itself cannot be taken back — the
// bound decides what the SCREEN does with it, not whether the Gate stops.

/** How long a round may run before the screen treats it as cancelled. */
export const COUNCIL_ROUND_TIMEOUT_MS = 120_000;

/** Said once, plainly, when the bound expires with answers still missing. */
export const COUNCIL_TIMEOUT_NOTE = 'Some Bots did not answer in time';
/** What a Bot that never came back leaves in its own column. */
export const COUNCIL_NO_ANSWER_COPY = 'No answer';
/** What a Stop leaves behind: the round is abandoned, not broken. */
export const COUNCIL_STOPPED_NOTE = 'Round stopped.';
/** No gateway, no council — said instead of a chip box that never fills. */
export const COUNCIL_OFFLINE_COPY = 'Connect to a gateway to compare Bots';

/**
 * The columns a bounded round ends with: every answer that DID land keeps its
 * column, and each Bot still missing one says so by name. A timeout never
 * rewrites an answer that arrived and never claims silence where there was none.
 */
export function councilNoAnswerColumns(
  targets: CouncilTarget[],
  arrived: CouncilColumn[] = [],
): CouncilColumn[] {
  return targets.map((target) => {
    const column = arrived.find((candidate) => candidate.botId === target.botId);
    if (column?.state === 'answered') return column;
    return { ...target, state: 'failed', error: COUNCIL_NO_ANSWER_COPY };
  });
}

/**
 * A promise with its own wall-clock bound. The transport's default is 30 s,
 * which is right for a request the operator is waiting on and far too long for
 * the room delete that follows one: that delete is bookkeeping whose failure is
 * deliberately swallowed, and it must never be the reason the button is stuck.
 *
 * The work is not cancelled, only stopped being waited on.
 */
export function boundedOperation<T>(work: Promise<T>, boundMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Gave up after ${boundMs}ms`)), boundMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ─── The ledger of transient rooms ─────────────────────────────────────────
// Create and delete are paired inside one async function, and a process the OS
// reclaims mid-round never runs the second half. So the intent is written down
// as soon as the room exists, and every connected mount sweeps what is old
// enough to be a leftover. Nothing here may throw: a storage refusal is a lost
// ledger entry, not a failed comparison.

export const COUNCIL_PENDING_ROOMS_KEY = 'versutus:council-pending-rooms';
/** A room older than this cannot belong to a round this process is running. */
export const COUNCIL_ROOM_LEAK_MS = 120_000;
/**
 * Only so a repeatedly killed process cannot grow the key without end.
 *
 * This is an ADMISSION bound, never an eviction rule. Every record in the ledger
 * is a room this device still owes the Gate a delete for, and the oldest ones
 * are exactly the leftovers `sweepPendingRooms` exists to delete. Dropping the
 * oldest to make room for a newcomer destroyed the only handle on that room, so
 * it was never swept again; the ledger was silently leaking the very records it
 * was kept for. A full ledger now keeps every record it already owes and refuses
 * the newcomer, loudly (`councilLedgerFullWarning`), so the bound caps how much
 * new debt one process can take on between sweeps — never what the sweep can
 * still settle.
 */
export const COUNCIL_PENDING_ROOM_CAP = 8;
/**
 * The per-room bound the sweep gives each delete. The transport's own default
 * is 30 s, which is far too long when several owed rooms are swept serially on
 * a half-open link: one stall must not hold the rooms behind it, and the ledger
 * must reflect each room the moment it lands.
 */
export const COUNCIL_SWEEP_DELETE_TIMEOUT_MS = 8_000;

/** One transient room whose deletion this device still owes the Gate. */
export type CouncilPendingRoom = { roomId: string; createdAt: number };

/**
 * Where the ledger keeps itself — `keyValueStorage` satisfies this, and a test
 * hands over a fake. It is passed in rather than imported so this module stays
 * free of a native storage handle, which is what lets the pure rules above be
 * read and tested on their own.
 */
export type CouncilRoomLedger = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

/** Use browser storage directly so refused reads and writes remain observable. */
export function councilRoomLedger(
  native: CouncilRoomLedger,
  webStorage?: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined,
): CouncilRoomLedger {
  if (!webStorage) return native;
  const storage = () => {
    const value = webStorage();
    if (!value) throw new Error('Browser storage is unavailable');
    return value;
  };
  return {
    async getItem(key) { return storage().getItem(key); },
    async setItem(key, value) { storage().setItem(key, value); },
    async removeItem(key) { storage().removeItem(key); },
  };
}

// Read-modify-write over one key: two overlapping mutations each build their
// list from the same snapshot, and the later write puts back the room the
// earlier one dropped. One tail keeps them in order. The network calls in a
// sweep stay OUTSIDE it — a slow delete must not sit in front of a live round's
// own ledger write.
let ledgerTail: Promise<void> = Promise.resolve();

function enqueueLedgerMutation<T>(task: () => Promise<T>): Promise<T> {
  const result = ledgerTail.then(task);
  ledgerTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function isPendingRoom(value: unknown): value is CouncilPendingRoom {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.roomId === 'string' && raw.roomId.length > 0 && typeof raw.createdAt === 'number';
}

/** What a stored ledger holds: a tolerant read, never a throw. */
export function parsePendingRooms(raw: string | null): CouncilPendingRoom[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPendingRoom);
  } catch {
    return [];
  }
}

/** What one admission attempt decided: the ledger to store, and any refused room. */
export type CouncilPendingRoomAdmission = {
  /** The ledger as it must be stored after this attempt. */
  records: CouncilPendingRoom[];
  /** The room that did not fit because the ledger was already full. */
  refused?: CouncilPendingRoom;
};

/** Why a room could not be written down as owed. */
export type CouncilPendingRoomRefusal = 'full' | 'unreadable' | 'unwritable';

/**
 * What recording a room actually achieved. `recorded: true` means the room is
 * durably in the ledger, so a process death can still be swept. A refusal or a
 * failed read/write is never reported as durable: the caller must not send a
 * round whose room it cannot later delete.
 */
export type CouncilPendingRoomNote = { recorded: true } | { recorded: false; reason: CouncilPendingRoomRefusal };

/**
 * Note one more owed delete, newest last, never duplicating a room already owed.
 *
 * A room that is already in the ledger only has its record refreshed, so a live
 * round that notes the same room twice never costs a slot. A NEW room at the
 * bound is refused instead of evicting a record: the rooms already recorded are
 * real debts `sweepPendingRooms` can still settle, and trading one of them for a
 * newcomer is the silent loss this ledger exists to prevent. This function is
 * pure; saying the refusal out loud is `notePendingRoom`'s job.
 */
export function rememberPendingRoom(
  records: CouncilPendingRoom[],
  roomId: string,
  createdAt: number,
): CouncilPendingRoomAdmission {
  const kept = records.filter((record) => record.roomId !== roomId);
  const record = { roomId, createdAt };
  if (kept.length !== records.length || kept.length < COUNCIL_PENDING_ROOM_CAP) {
    return { records: [...kept, record] };
  }
  return { records, refused: record };
}

/** What the log says when a full ledger had to refuse a room. Never silent. */
export function councilLedgerFullWarning(roomId: string): string {
  return `pending-room ledger full (${COUNCIL_PENDING_ROOM_CAP} rooms); the delete for ${roomId} was not recorded and cannot be swept if this round is killed`;
}

/** What the log says when the ledger could not be read or written. Never silent. */
export function councilLedgerRefusalWarning(
  roomId: string,
  reason: CouncilPendingRoomRefusal,
): string {
  if (reason === 'full') return councilLedgerFullWarning(roomId);
  const cause = reason === 'unreadable' ? 'could not be read' : 'write was refused';
  return `pending-room ledger ${cause}; the delete for ${roomId} was not recorded and cannot be swept if this round is killed`;
}

/**
 * What the operator is told when a round could not admit its room. The round is
 * not sent at all, so the copy says that plainly and names the one useful next
 * step rather than reading as a failed answer from a Bot.
 */
export function councilLedgerRefusalCopy(reason: CouncilPendingRoomRefusal): string {
  switch (reason) {
    case 'full':
      return "This comparison was not sent: the council's pending-room list is full, so this round's room could not be recorded for cleanup. Reconnect once earlier rooms have aged out so they can be swept, then compare again.";
    case 'unreadable':
      return "This comparison was not sent: the council could not read its pending-room list, so this round's room could not be recorded for cleanup. Reconnect and compare again.";
    case 'unwritable':
      return "This comparison was not sent: the council could not save this round's room for cleanup. Reconnect and compare again.";
  }
}

/** The rooms still owed once these are settled. */
export function forgetPendingRooms(
  records: CouncilPendingRoom[],
  roomIds: Iterable<string>,
): CouncilPendingRoom[] {
  const settled = new Set(roomIds);
  return records.filter((record) => !settled.has(record.roomId));
}

/** A room old enough to be a leftover rather than a round in flight. */
export function isStalePendingRoom(record: CouncilPendingRoom, now: number): boolean {
  return now - record.createdAt >= COUNCIL_ROOM_LEAK_MS;
}

export function stalePendingRooms(records: CouncilPendingRoom[], now: number): CouncilPendingRoom[] {
  return records.filter((record) => isStalePendingRoom(record, now));
}

/**
 * True when the Gate has nothing left to delete: a 404, or a refusal worded
 * that way by a transport that lost the status. Such a delete is as good as one
 * that succeeded, so the record goes and the sweep does not keep asking.
 */
export function councilRoomGone(cause: unknown): boolean {
  if (cause instanceof GatewayHttpError) return cause.status === 404;
  const message = cause instanceof Error ? cause.message : String(cause);
  return /\b404\b|not found|unknown room|no such (?:room|group)/i.test(message);
}

/**
 * The ledger as stored, or `undefined` when it could not be read or its shape
 * is not the one this module writes. An unreadable or malformed ledger must
 * never be rewritten as if it were empty: that would drop every room the device
 * still owes. Callers that settle or sweep a room skip the write on
 * `undefined`; admission refuses the newcomer instead.
 *
 * `parsePendingRooms` stays deliberately tolerant for surfaces that only want a
 * best-effort read. Every mutation uses this strict reader.
 */
function readStoredPendingRooms(raw: string | null): CouncilPendingRoom[] | undefined {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    // A single malformed entry is enough to make the whole blob unsafe to
    // rewrite: filtering it out would lose that room's last handle.
    if (!parsed.every(isPendingRoom)) return undefined;
    return parsed.filter(isPendingRoom);
  } catch {
    return undefined;
  }
}

async function loadPendingRooms(ledger: CouncilRoomLedger): Promise<CouncilPendingRoom[] | undefined> {
  try {
    return readStoredPendingRooms(await ledger.getItem(COUNCIL_PENDING_ROOMS_KEY));
  } catch {
    return undefined;
  }
}

async function savePendingRooms(ledger: CouncilRoomLedger, records: CouncilPendingRoom[]): Promise<void> {
  try {
    if (records.length === 0) {
      await ledger.removeItem(COUNCIL_PENDING_ROOMS_KEY);
      return;
    }
    await ledger.setItem(COUNCIL_PENDING_ROOMS_KEY, JSON.stringify(records));
  } catch {
    // Best-effort by construction: the round that wrote this record is already
    // committed, and a refusal here costs at most a re-sweep later.
  }
}

/**
 * Record a room this device now owes the Gate a delete for. Never throws, and
 * only reports `recorded: true` when the room is durably in the ledger: a read
 * or write refusal is a refusal, never a pretend success. A full ledger keeps
 * every record it already owes and refuses the newcomer.
 */
export async function notePendingRoom(
  ledger: CouncilRoomLedger,
  roomId: string,
  now: number = Date.now(),
): Promise<CouncilPendingRoomNote> {
  if (!roomId) return { recorded: false, reason: 'unwritable' };
  return enqueueLedgerMutation(async (): Promise<CouncilPendingRoomNote> => {
    // A failed read or a blob this build cannot understand is not an empty
    // ledger: writing one would drop every room still owed, so the newcomer is
    // refused instead.
    const records = await loadPendingRooms(ledger);
    if (!records) {
      console.warn(`[council] ${councilLedgerRefusalWarning(roomId, 'unreadable')}`);
      return { recorded: false, reason: 'unreadable' };
    }
    const admission = rememberPendingRoom(records, roomId, now);
    if (admission.refused) {
      // A full ledger is not a reason to lose a room quietly: the records
      // already owed stay exactly as they are, and the refusal is said out
      // loud so it can be found in the log rather than discovered later as an
      // orphan room on the Gate.
      console.warn(`[council] ${councilLedgerFullWarning(admission.refused.roomId)}`);
      return { recorded: false, reason: 'full' };
    }
    try {
      await ledger.setItem(COUNCIL_PENDING_ROOMS_KEY, JSON.stringify(admission.records));
    } catch {
      // The write did not land (or cannot be proven to have landed). The caller
      // must not send a round whose room it cannot delete after a process death.
      console.warn(`[council] ${councilLedgerRefusalWarning(roomId, 'unwritable')}`);
      return { recorded: false, reason: 'unwritable' };
    }
    return { recorded: true };
  });
}

/** The room is gone (or was never there): stop owing it. Never throws. */
export async function clearPendingRoom(ledger: CouncilRoomLedger, roomId: string): Promise<void> {
  if (!roomId) return;
  await enqueueLedgerMutation(async () => {
    const records = await loadPendingRooms(ledger);
    // An unreadable ledger is left untouched: rewriting it would drop every
    // room the device still owes.
    if (!records) return;
    await savePendingRooms(ledger, forgetPendingRooms(records, [roomId]));
  });
}

/**
 * Delete every room this device recorded and has owed for longer than the leak
 * bound, dropping each one as it settles. A delete that fails for any other
 * reason keeps its record, so the next mount tries again instead of losing it.
 *
 * Each delete carries its own bound, so one half-open link cannot hold the
 * rooms behind it for the transport's full 30 s apiece. The ledger is rewritten
 * as each room lands rather than once after the loop, so a later stall never
 * discards the deletions that already succeeded.
 */
export async function sweepPendingRooms(
  ledger: CouncilRoomLedger,
  deleteRoom: (roomId: string) => Promise<unknown>,
  now: number = Date.now(),
  boundMs: number = COUNCIL_SWEEP_DELETE_TIMEOUT_MS,
): Promise<void> {
  const records = await loadPendingRooms(ledger);
  // An unreadable ledger leaves the sweep with nothing it can safely settle.
  if (!records) return;
  const stale = stalePendingRooms(records, now);
  if (stale.length === 0) return;
  for (const record of stale) {
    let settled = false;
    try {
      await boundedOperation(deleteRoom(record.roomId), boundMs);
      settled = true;
    } catch (cause) {
      if (councilRoomGone(cause)) settled = true;
    }
    if (settled) await settleSweptRoom(ledger, record.roomId);
  }
}

/** Drop one settled room from the ledger. Best-effort, like every ledger write. */
async function settleSweptRoom(ledger: CouncilRoomLedger, roomId: string): Promise<void> {
  await enqueueLedgerMutation(async () => {
    const records = await loadPendingRooms(ledger);
    if (!records) return;
    await savePendingRooms(ledger, forgetPendingRooms(records, [roomId]));
  });
}
