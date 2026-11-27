// ─── Collect one turn's file evidence ──────────────────────────────
// VS-094, slice 2: the seam that feeds `turn-changes.ts` from what a turn
// actually produced.
//
// The pure module already knows how to read one tool call, bound a window and
// merge evidence. This file is the only place that gathers those inputs:
//   - live tool frames (what the stream reducer emitted) and the tool calls on
//     the turn's own `ChatMessage[]`, read with `extractFileEvidence`;
//   - the journal meta (started/updated/finished), read through an injected
//     fetcher so tests never touch the network or a Gate;
//   - an OpenCode before/after diff snapshot, when the caller has one.
//
// Everything is keyed on `turnId`: a frame or a message that names a different
// turn is foreign and is ignored, never merged. Read-like calls (`Read`,
// `Grep`, `Glob`, a plain `cat`) fall out inside `extractFileEvidence`; the
// collector must not add a second opinion about them.
//
// `detail` is read for paths and then discarded. Nothing in the record, and
// nothing this module returns, carries the arguments it was given.

import type { ChatMessage } from '@/lib/gateway/types';
import type {
  TurnChangeCaps,
  TurnChangeRecord,
  TurnDiffRow,
  TurnJournalMeta,
  TurnObservation,
} from '@/lib/chat/turn-changes';
import {
  boundTurn,
  capTurnChanges,
  extractFileEvidence,
  mergeTurnEvidence,
} from '@/lib/chat/turn-changes';

/**
 * The journal meta as the app already receives it from `GET /v1/turns/{id}`.
 *
 * It is structurally a superset of `TurnJournalMeta` (`TurnMeta` from
 * `@/lib/gateway/turns` fits as-is), plus the two identity fields the record
 * needs when the caller did not supply them.
 */
export type TurnJournalRecord = TurnJournalMeta & {
  sessionId?: string;
  backendId?: string | null;
};

/**
 * The journal seam. A caller passes the existing client's `getTurn` (or a test
 * fixture); this module never opens a route of its own.
 *
 * A rejection is a REFUSED read — auth, timeout, a host that is down — and is
 * treated as "unavailable" (no record), never as an empty change list.
 */
export type TurnJournalMetaFetcher = (turnId: string) => Promise<TurnJournalRecord | null>;

/**
 * One live tool frame for a turn.
 *
 * `kind: 'completed'` marks a frame that carries a tool RESULT rather than its
 * arguments. It is still used for the window fallback, but never mined for
 * paths: shell output can name a path it only read (design §1, §6).
 */
export type TurnChangeFrame = {
  /** The turn the frame belongs to. Absent means "the turn being collected". */
  turnId?: string;
  /** Frame time, used only when the journal has no timestamps. */
  at?: number;
  kind?: 'started' | 'completed';
  id?: string;
  name: string;
  detail?: string;
};

export type CollectTurnChangeInput = {
  /** The Gate turn everything is keyed on. */
  turnId: string;
  sessionId: string;
  backendId: string;
  /** This turn's messages. A message naming another turn is ignored. */
  messages?: readonly ChatMessage[];
  /** This turn's live tool frames, in arrival order. */
  frames?: readonly TurnChangeFrame[];
  /**
   * The journal's meta for this turn, when the read succeeded. Absent/null
   * means "no journal" (the window falls back to frame times); a REFUSED read
   * belongs in `collectTurnChangesFromJournal`, which turns it into `null`.
   */
  journalMeta?: TurnJournalRecord | null;
  /** OpenCode's session diff before the turn (the licence to attribute). */
  diffBefore?: readonly TurnDiffRow[] | null;
  /** OpenCode's session diff after the turn. */
  diffAfter?: readonly TurnDiffRow[] | null;
  /** Per-record caps; the landed defaults apply when omitted. */
  caps?: TurnChangeCaps;
};

export type CollectTurnChangeFromJournalInput = Omit<
  CollectTurnChangeInput,
  'sessionId' | 'backendId' | 'journalMeta'
> & {
  /** Optional when the journal supplies them (it normally does). */
  sessionId?: string;
  backendId?: string;
  readJournalMeta: TurnJournalMetaFetcher;
};

/**
 * True when an item belongs to the turn being collected.
 *
 * A message carries `turnId` explicitly, so a different id is another turn.
 * A tool frame has no turn id of its own in the stream reducer, so a frame
 * without one is taken as part of the single turn the caller handed us; a
 * frame that DOES name a turn must name this one.
 */
function isMessageInTurn(message: ChatMessage, turnId: string): boolean {
  return message.turnId === turnId;
}

function isFrameInTurn(frame: TurnChangeFrame, turnId: string): boolean {
  return frame.turnId === undefined || frame.turnId === turnId;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

type CallInput = {
  id?: string;
  name: string;
  detail?: string;
  at?: number;
};

function observationsFor(
  backendId: string,
  calls: readonly CallInput[],
): TurnObservation[] {
  const observations: TurnObservation[] = [];
  for (const call of calls) {
    if (typeof call.name !== 'string' || !call.name) continue;
    const evidence = extractFileEvidence({
      backend: backendId,
      name: call.name,
      detail: call.detail,
    });
    if (evidence.paths.length === 0 || evidence.kind === null) continue;
    const callId = nonEmpty(call.id);
    for (const path of evidence.paths) {
      observations.push({
        ...(callId ? { callId } : {}),
        tool: call.name,
        path,
        kind: evidence.kind,
        confidence: evidence.confidence,
        ...(typeof call.at === 'number' && Number.isFinite(call.at) ? { seenAt: call.at } : {}),
      });
    }
  }
  return observations;
}

function callsFromMessages(
  messages: readonly ChatMessage[],
  turnId: string,
): CallInput[] {
  const calls: CallInput[] = [];
  for (const message of messages) {
    if (!isMessageInTurn(message, turnId)) continue;
    for (const tool of message.toolCalls ?? []) {
      calls.push({
        ...(tool.id ? { id: tool.id } : {}),
        name: tool.name,
        ...(tool.detail !== undefined ? { detail: tool.detail } : {}),
        ...(typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
          ? { at: message.timestamp }
          : {}),
      });
    }
  }
  return calls;
}

function callsFromFrames(
  frames: readonly TurnChangeFrame[],
  turnId: string,
): CallInput[] {
  const calls: CallInput[] = [];
  for (const frame of frames) {
    if (!isFrameInTurn(frame, turnId)) continue;
    // A completed frame is a result, not arguments. It must not invent a path.
    if (frame.kind === 'completed') continue;
    calls.push({
      ...(frame.id ? { id: frame.id } : {}),
      name: frame.name,
      ...(frame.detail !== undefined ? { detail: frame.detail } : {}),
      ...(typeof frame.at === 'number' && Number.isFinite(frame.at) ? { at: frame.at } : {}),
    });
  }
  return calls;
}

/**
 * Turn one turn's messages, frames, journal meta and optional diff into the
 * capped record the store persists (design §2, §3, §5 items 1-4).
 *
 * Returns `null` when there is no honest record to make:
 *   - the journal meta names a different turn;
 *   - no window exists at all (`boundTurn` found no timestamp anywhere);
 *   - the turn has no identity to key the record on.
 *
 * A turn with a window but no write-like call returns a record with
 * `files: []`: that is "nothing changed", which is different from `null`
 * ("unavailable"). The UI decides whether to show a row; `toTurnChangeSummary`
 * already answers `null` for an empty file list.
 */
export function collectTurnChanges(input: CollectTurnChangeInput): TurnChangeRecord | null {
  const turnId = nonEmpty(input.turnId);
  const sessionId = nonEmpty(input.sessionId);
  const backendId = nonEmpty(input.backendId);
  if (!turnId || !sessionId || !backendId) return null;

  const journalMeta = input.journalMeta ?? null;
  // A journal row for another turn cannot license this turn's window.
  if (journalMeta?.turnId && journalMeta.turnId !== turnId) return null;

  const messages = input.messages ?? [];
  const frames = input.frames ?? [];

  const windowMessages = [
    ...messages.map((message) => ({
      turnId: message.turnId,
      ...(typeof message.timestamp === 'number' ? { timestamp: message.timestamp } : {}),
    })),
    ...frames.map((frame) => ({
      turnId: frame.turnId ?? turnId,
      ...(typeof frame.at === 'number' ? { timestamp: frame.at } : {}),
    })),
  ];

  const window = boundTurn({
    messages: windowMessages,
    journalMeta: journalMeta
      ? {
          turnId,
          status: journalMeta.status,
          startedAt: journalMeta.startedAt,
          updatedAt: journalMeta.updatedAt,
          finishedAt: journalMeta.finishedAt,
        }
      : { turnId },
  });
  if (!window) return null;

  const observations = observationsFor(backendId, [
    ...callsFromMessages(messages, turnId),
    ...callsFromFrames(frames, turnId),
  ]);

  const merged = mergeTurnEvidence(
    {
      turnId,
      sessionId,
      backendId,
      startedAt: window.startedAt,
      endedAt: window.endedAt,
      items: observations,
    },
    input.diffBefore,
    input.diffAfter,
  );

  return capTurnChanges(merged, input.caps);
}

/**
 * The journal-fed collector.
 *
 * Reads this turn's meta through the injected fetcher, takes identity from the
 * caller or the journal, then delegates to `collectTurnChanges`. A rejected
 * read yields `null` — "Changes are unavailable for this turn" — rather than an
 * empty record that would read as "this turn changed nothing".
 */
export async function collectTurnChangesFromJournal(
  input: CollectTurnChangeFromJournalInput,
): Promise<TurnChangeRecord | null> {
  const { readJournalMeta, ...rest } = input;
  let journalMeta: TurnJournalRecord | null = null;
  try {
    journalMeta = await readJournalMeta(input.turnId);
  } catch {
    // A refused read is not an answer. No record is better than a wrong one.
    return null;
  }

  const sessionId = nonEmpty(input.sessionId)
    ?? nonEmpty(journalMeta?.sessionId);
  const backendId = nonEmpty(input.backendId)
    ?? nonEmpty(journalMeta?.backendId ?? undefined);
  if (!sessionId || !backendId) return null;

  return collectTurnChanges({
    ...rest,
    sessionId,
    backendId,
    journalMeta,
  });
}
