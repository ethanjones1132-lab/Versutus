// ─── Durable turns: the Gate's journal, read from the phone ────────
//
// A turn belongs to the Gate, not to the HTTP request that started it: every
// event of it is journaled, and any subscriber (this request, a later request
// after a reconnect, another device) replays the journal from a sequence number
// and then follows it live. The contract is `docs/design/durable-turns.md` §3.
//
// Everything here is either a type or a pure decision. The transport lives on
// the clients (`ManifestClient`), which is the only place that knows how a
// given gateway is addressed — and a gateway with no journal (Hermes direct, an
// older Gate) simply omits these methods, so the app degrades to what it did
// before rather than failing.

import { createChatStreamAcc, interpretChatStreamChunk } from '@/lib/gateway/chat-stream-delta';
import { errorCodeFromHttpBody, messageFromHttpErrorBody } from '@/lib/gateway/http-error-body';
import { interruptedTurnCopy } from '@/lib/gateway/interrupted-copy';
import type { HttpTransport } from '@/lib/gateway/http-transport';
import type { ModelReport } from '@/lib/gateway/run-failures';
import type { ChatToolCall } from '@/lib/gateway/types';

/** How a turn ended, exactly as the Gate journals it (§3.2). */
export type TurnStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

/** A status this build does not know is still a status; it is never a guess. */
export type TurnStatusValue = TurnStatus | 'unknown';

/** Why the GATE ended a turn, as opposed to the model finishing it. */
export type TurnEndReason = 'gate_restart' | 'stalled' | 'max_age';

export type TurnMeta = {
  turnId: string;
  sessionId?: string;
  backendId?: string | null;
  botId?: string | null;
  model?: string | null;
  status: TurnStatusValue;
  startedAt?: number;
  updatedAt?: number;
  finishedAt?: number | null;
  /** The last journal seq written for this turn. */
  lastSeq?: number;
  /** The failure a `failed` turn ended with. */
  error?: string | null;
  /** Why the Gate itself ended an `interrupted` turn. */
  reason?: string | null;
  /** The assembled reply so far — on a single-turn read (`GET /v1/turns/{id}`). */
  text?: string;
};

export type TurnListFilter = {
  sessionId?: string;
  status?: TurnStatusValue;
  limit?: number;
};

/** The callbacks a turn-event stream reports through — the chat stream's own set. */
export type TurnStreamCallbacks = {
  onDelta: (text: string) => void;
  onToolCall?: (tool: ChatToolCall) => void;
  onReasoning?: (text: string) => void;
  onTelemetryWarning?: (message: string) => void;
  onModelReport?: (report: ModelReport) => void;
  /**
   * The journal seq of the frame just handled. A dropped stream re-attaches
   * `after` the last one it rendered, so a replay is never shown twice.
   */
  onSeq?: (seq: number) => void;
};

export type TurnEventStreamOptions = TurnStreamCallbacks & {
  /** Replay only what this process has not already rendered. */
  after?: number;
  signal?: AbortSignal;
};

export type TurnStreamResult = {
  /** True when the stream's terminal `[DONE]` arrived. */
  completed: boolean;
  /** Every text delta this read carried. */
  text: string;
  /** A terminal error frame's message, when the Gate sent one. */
  error: string | null;
  /** That frame's code, when it named one (`gate_restart` is the one that matters). */
  errorCode?: string;
  /** The highest seq seen: where a re-attach reads from next. */
  lastSeq: number;
};

/**
 * What the journal says became of a turn. `running` is an answer too: the turn
 * is still the Gate's, and a bubble waiting on it must not be settled.
 */
export type TurnSettlement =
  | { kind: 'done'; text: string }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' }
  | { kind: 'interrupted'; reason: TurnEndReason | 'unknown'; copy: string }
  | { kind: 'running' }
  | { kind: 'unknown' };

const TURN_STATUSES: readonly TurnStatus[] = [
  'running',
  'done',
  'failed',
  'cancelled',
  'interrupted',
];

/** The journal status of a value, or `undefined` when it names none of ours. */
export function turnStatusOf(value: unknown): TurnStatus | undefined {
  return typeof value === 'string' && (TURN_STATUSES as readonly string[]).includes(value)
    ? (value as TurnStatus)
    : undefined;
}

const TURN_END_REASONS: readonly TurnEndReason[] = ['gate_restart', 'stalled', 'max_age'];

/** Why the Gate ended the turn, or `unknown` when it named no reason we know. */
export function turnEndReasonOf(value: unknown): TurnEndReason | 'unknown' {
  return typeof value === 'string' && (TURN_END_REASONS as readonly string[]).includes(value)
    ? (value as TurnEndReason)
    : 'unknown';
}

/**
 * One journal record as the app reads it: a turn with no id is not a turn, and
 * a status we do not know is kept as `unknown` rather than guessed into a
 * finished one (guessing is how a cut-off turn used to read as a reply).
 */
export function turnFromMeta(value: unknown): TurnMeta | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const turnId =
    (typeof raw.turnId === 'string' && raw.turnId) ||
    (typeof raw.id === 'string' && raw.id) ||
    '';
  if (!turnId) return null;
  const text = typeof raw.text === 'string' ? raw.text : undefined;
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : undefined;
  const meta: TurnMeta = {
    turnId,
    status: turnStatusOf(raw.status) ?? 'unknown',
  };
  if (sessionId) meta.sessionId = sessionId;
  const error = typeof raw.error === 'string' ? raw.error : undefined;
  if (error) meta.error = error;
  const reason = typeof raw.reason === 'string' ? raw.reason : undefined;
  if (reason) meta.reason = reason;
  if (text !== undefined) meta.text = text;
  const lastSeq = typeof raw.lastSeq === 'number' ? raw.lastSeq : undefined;
  if (typeof lastSeq === 'number' && Number.isFinite(lastSeq)) meta.lastSeq = lastSeq;
  if (typeof raw.startedAt === 'number') meta.startedAt = raw.startedAt;
  if (typeof raw.updatedAt === 'number') meta.updatedAt = raw.updatedAt;
  if (typeof raw.finishedAt === 'number') meta.finishedAt = raw.finishedAt;
  return meta;
}

/**
 * The records in a `GET /v1/turns` answer. The Gate sends `{ object, data }`;
 * a bare array is read too, because a list is the one shape every gateway in
 * this app agrees on. Anything else is no turns — never a guess.
 */
export function turnsFromListEnvelope(value: unknown): TurnMeta[] {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data)
      ? (value as { data: unknown[] }).data
      : [];
  const turns: TurnMeta[] = [];
  for (const row of rows) {
    const turn = turnFromMeta(row);
    if (turn) turns.push(turn);
  }
  return turns;
}

/** What the journal says became of a turn — the settlement by identity. */
export function turnSettlement(turn: TurnMeta): TurnSettlement {
  switch (turn.status) {
    case 'running':
      return { kind: 'running' };
    case 'done':
      return { kind: 'done', text: turn.text?.trim() ?? '' };
    case 'failed':
      return { kind: 'failed', message: turn.error?.trim() || 'The turn failed on your PC.' };
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'interrupted':
      return {
        kind: 'interrupted',
        reason: turnEndReasonOf(turn.reason),
        copy: interruptedTurnCopy(turn.reason),
      };
    default:
      return { kind: 'unknown' };
  }
}

/** The `error.code` of an SSE frame, which is what names a Gate restart. */
export function streamFrameErrorCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code ? code : undefined;
}

/** The code a failed stream carried, when its transport kept one. */
export function streamErrorCodeOf(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code ? code : undefined;
}

/**
 * A failure that is the GATE ending the turn rather than the model failing it.
 *
 * §3.5: a restart ends every attached stream with `code: gate_restart` and
 * journals the turn `interrupted`. That is an interruption with a reason, never
 * a red failure card and never a finished half answer — so the code is read
 * when the transport kept it, and the Gate's own words are the fallback for a
 * client that does not.
 */
export function isGateRestartFailure(error: unknown): boolean {
  if (streamErrorCodeOf(error) === 'gate_restart') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /gate restarted/i.test(message);
}

/**
 * The failure a stream ended on, carrying the frame's code when it named one.
 *
 * The message the bubble shows is the Gate's own, unchanged — the code rides
 * alongside it so the caller can tell a restart from a model failure without
 * the operator ever seeing it.
 */
export function streamFailure(message: string, code?: string): Error {
  const error = new Error(message);
  if (code) (error as Error & { code?: string }).code = code;
  return error;
}

/** The message a non-2xx turn read carries, so a 404 is never a bare status. */
export function turnReadFailureMessage(bodyText: string, status: number): string {
  return messageFromHttpErrorBody(bodyText, status);
}

/** The code a non-2xx turn read carried — `unknown_turn` is the one that matters. */
export function turnReadFailureCode(bodyText: string): string | undefined {
  return errorCodeFromHttpBody(bodyText);
}

/**
 * The one reader a chat stream and a turn-event replay both go through.
 *
 * `GET /v1/turns/{id}/events` replays the very `data:` payloads the chat stream
 * wrote to the journal (§3.3), so a re-attached turn needs the same frame
 * handling as a live send — not a second parser that can drift from it. The
 * per-frame `id:` seq is reported as well, which is what lets a dropped stream
 * pick up where it stopped.
 */
export async function readChatFrames(args: {
  response: Response;
  transport: HttpTransport;
  signal?: AbortSignal;
  /** Frames at or below this seq were rendered already and are not reported. */
  after?: number;
  callbacks: TurnStreamCallbacks;
}): Promise<TurnStreamResult> {
  const { response, transport, signal, callbacks } = args;
  const after = args.after ?? 0;
  let fullText = '';
  // A failed turn arrives as an error frame inside an HTTP 200 stream, so the
  // status line cannot catch it. Captured here rather than thrown, because the
  // reader's own caller's handler is the only thing that can decide what an
  // error frame means for the bubble it interrupted.
  let streamError: string | null = null;
  let streamErrorCode: string | undefined;
  let lastSeq = after;
  const acc = createChatStreamAcc();
  const completed = await transport.streamSSE(
    response,
    (data) => {
      try {
        const frame: unknown = JSON.parse(data);
        const interpreted = interpretChatStreamChunk(frame, acc);
        if (interpreted.streamError) {
          streamError = interpreted.streamError;
          streamErrorCode = streamFrameErrorCode(frame);
          return;
        }
        if (interpreted.telemetryWarning) callbacks.onTelemetryWarning?.(interpreted.telemetryWarning);
        if (interpreted.text) {
          fullText += interpreted.text;
          callbacks.onDelta(interpreted.text);
        }
        if (interpreted.reasoning) callbacks.onReasoning?.(interpreted.reasoning);
        if (callbacks.onToolCall) {
          for (const tool of interpreted.toolCalls) callbacks.onToolCall(tool);
        }
        if (interpreted.ranModel && callbacks.onModelReport) {
          callbacks.onModelReport({
            ran: interpreted.ranModel,
            requested: interpreted.requestedModel,
            provider: interpreted.provider,
          });
        }
      } catch {
        // A malformed frame must not kill the stream — matches every other
        // reader in this app.
      }
    },
    signal,
    {
      onId: (raw) => {
        const seq = Number(raw);
        if (!Number.isFinite(seq)) return;
        lastSeq = seq;
        if (seq > after) callbacks.onSeq?.(seq);
      },
    },
  );
  return {
    completed,
    text: fullText,
    error: streamError,
    errorCode: streamErrorCode,
    lastSeq,
  };
}

/**
 * The turn-journal surface a client offers. Optional on every adapter: a
 * gateway with no journal (Hermes direct, an older Gate) omits the whole group,
 * and the app then behaves exactly as it did before this protocol existed.
 */
export type TurnCapableClient = {
  listTurns?(filter?: TurnListFilter): Promise<TurnMeta[]>;
  getTurn?(turnId: string): Promise<TurnMeta | null>;
  streamTurnEvents?(turnId: string, options: TurnEventStreamOptions): Promise<TurnStreamResult>;
  /**
   * True once this gateway has answered 404 for `/v1/turns` in this session.
   * The app reads it to stop asking: one refusal is a fact about the gateway,
   * not a transient failure to retry.
   */
  readonly turnsUnsupported?: boolean;
};

/**
 * A client that DOES keep a journal — the whole group present, nothing refused
 * yet. Narrower than `TurnCapableClient` so no call site can hold a half-gateway
 * and then guard each method again.
 */
export type TurnJournal = {
  listTurns(filter?: TurnListFilter): Promise<TurnMeta[]>;
  getTurn(turnId: string): Promise<TurnMeta | null>;
  streamTurnEvents(turnId: string, options: TurnEventStreamOptions): Promise<TurnStreamResult>;
  readonly turnsUnsupported?: boolean;
};

/**
 * The client as a turn journal, or null when it keeps no journal (or has
 * already told us it does not). One gate for every caller, so no call site can
 * ask a gateway that cannot answer.
 */
export function turnClientOf(client: unknown): TurnJournal | null {
  const candidate = client as TurnCapableClient | null;
  if (!candidate || candidate.turnsUnsupported === true) return null;
  const { listTurns, getTurn, streamTurnEvents } = candidate;
  if (
    typeof listTurns !== 'function' ||
    typeof getTurn !== 'function' ||
    typeof streamTurnEvents !== 'function'
  ) {
    return null;
  }
  return candidate as unknown as TurnJournal;
}
