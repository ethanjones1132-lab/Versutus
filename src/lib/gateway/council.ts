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
/** Only so a repeatedly killed process cannot grow the key without end. */
const COUNCIL_PENDING_ROOM_CAP = 8;
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

// Read-modify-write over one key: two overlapping mutations each build their
// list from the same snapshot, and the later write puts back the room the
// earlier one dropped. One tail keeps them in order. The network calls in a
// sweep stay OUTSIDE it — a slow delete must not sit in front of a live round's
// own ledger write.
let ledgerTail: Promise<void> = Promise.resolve();

function enqueueLedgerMutation(task: () => Promise<void>): Promise<void> {
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

/** One more owed delete, newest last, never duplicating a room already owed. */
export function rememberPendingRoom(
  records: CouncilPendingRoom[],
  roomId: string,
  createdAt: number,
): CouncilPendingRoom[] {
  const kept = records.filter((record) => record.roomId !== roomId);
  return [...kept, { roomId, createdAt }].slice(-COUNCIL_PENDING_ROOM_CAP);
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

async function loadPendingRooms(ledger: CouncilRoomLedger): Promise<CouncilPendingRoom[]> {
  try {
    return parsePendingRooms(await ledger.getItem(COUNCIL_PENDING_ROOMS_KEY));
  } catch {
    // An unreadable ledger is an empty one; the sweep then has nothing to do
    // rather than deleting rooms nobody is tracking.
    return [];
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

/** Record a room this device now owes the Gate a delete for. Never throws. */
export async function notePendingRoom(
  ledger: CouncilRoomLedger,
  roomId: string,
  now: number = Date.now(),
): Promise<void> {
  if (!roomId) return;
  await enqueueLedgerMutation(async () => {
    await savePendingRooms(ledger, rememberPendingRoom(await loadPendingRooms(ledger), roomId, now));
  });
}

/** The room is gone (or was never there): stop owing it. Never throws. */
export async function clearPendingRoom(ledger: CouncilRoomLedger, roomId: string): Promise<void> {
  if (!roomId) return;
  await enqueueLedgerMutation(async () => {
    await savePendingRooms(ledger, forgetPendingRooms(await loadPendingRooms(ledger), [roomId]));
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
  const stale = stalePendingRooms(await loadPendingRooms(ledger), now);
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
    await savePendingRooms(ledger, forgetPendingRooms(await loadPendingRooms(ledger), [roomId]));
  });
}
