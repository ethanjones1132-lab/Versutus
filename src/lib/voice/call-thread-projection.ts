import type { ChatMessage, ChatToolCall } from '@/lib/gateway/types';
import type { GateVoiceFrame } from '@/lib/voice/voice-stream-protocol';
import { foldCallReplyDelta } from './call-reply-delta';

/** Slice 3 adds this frame to the wire parser; keeping its projection shape local avoids protocol changes here. */
export type CallToolFrame = {
  t: 'tool';
  turnId: string;
  toolId: string;
  name: string;
  status: 'running' | 'complete' | 'error';
  summary: string;
  callId?: string;
  seq?: number;
  v?: 2;
};

export type CallProjectionFrame = GateVoiceFrame | CallToolFrame;

export type CallThreadProjection = {
  threadKey: string;
  callId: string;
  lastSeq: number;
  messages: ChatMessage[];
  replyOffsets: Record<string, number>;
  /** Native IDs visible before opening the socket; identical old turns aren't evidence. */
  historyBeforeCall?: ReadonlySet<string>;
  ended?: boolean;
};

export function emptyCallThreadProjection(
  threadKey: string,
  callId: string,
): CallThreadProjection {
  return { threadKey, callId, lastSeq: 0, messages: [], replyOffsets: {} };
}

function updateMessage(
  messages: ChatMessage[],
  id: string,
  update: (message: ChatMessage | undefined) => ChatMessage,
): ChatMessage[] {
  const index = messages.findIndex((message) => message.id === id);
  const next = [...messages];
  next[index < 0 ? next.length : index] = update(index < 0 ? undefined : messages[index]);
  return next;
}

function textMessage(
  id: string,
  turnId: string | undefined,
  text: string,
  role: ChatMessage['role'] = 'assistant',
): ChatMessage {
  return { id, role, text, turnId };
}

/** Fold a sequenced Gate event into the live transcript for one captured thread. */
export function projectCallFrame(
  projection: CallThreadProjection,
  frame: CallProjectionFrame,
): CallThreadProjection {
  if ('callId' in frame && frame.callId && frame.callId !== projection.callId) return projection;
  if ('v' in frame && frame.v === 2 && 'seq' in frame && typeof frame.seq === 'number') {
    // A missed Gate frame — one dropped frame, or a reconnect whose replay
    // window slid — must not freeze the thread for the rest of the call: the
    // hole is accepted and folding continues from the Gate's own account, the
    // same way the banner cursor does. Duplicates and old frames are still
    // rejected.
    if (frame.seq <= projection.lastSeq) return projection;
  }

  let next: CallThreadProjection = {
    ...projection,
    lastSeq: 'v' in frame && frame.v === 2 && 'seq' in frame && typeof frame.seq === 'number'
      ? frame.seq
      : projection.lastSeq,
  };
  switch (frame.t) {
    case 'final':
      next = {
        ...next,
        messages: updateMessage(next.messages, `voice:${projection.callId}:${frame.turnId}`, (existing) => ({
          ...(existing ?? textMessage(`voice:${projection.callId}:${frame.turnId}`, frame.turnId, frame.text, 'user')),
          text: frame.text,
          turnId: frame.turnId,
        })),
      };
      break;
    case 'reply': {
      const id = `voice-reply:${projection.callId}:${frame.turnId}`;
      const prior = next.messages.find((message) => message.id === id);
      const existingText = prior?.text ?? '';
      const cursor = next.replyOffsets[frame.turnId] ?? existingText.length;
      const folded = foldCallReplyDelta(existingText, cursor, frame.delta, frame.offset);
      if (folded.text !== existingText) {
        next = {
          ...next,
          messages: updateMessage(next.messages, id, () => ({
            ...(prior ?? textMessage(id, frame.turnId, '', 'assistant')),
            text: folded.text,
            turnId: frame.turnId,
            streaming: true,
          })),
          replyOffsets: { ...next.replyOffsets, [frame.turnId]: folded.cursor },
        };
      }
      break;
    }
    case 'tool': {
      const id = `voice-reply:${projection.callId}:${frame.turnId}`;
      const tool: ChatToolCall = { id: frame.toolId, name: frame.name, status: frame.status, detail: frame.summary };
      next = {
        ...next,
        messages: updateMessage(next.messages, id, (prior) => {
          const base = prior ?? textMessage(id, frame.turnId, '', 'assistant');
          const calls = base.toolCalls ?? [];
          const at = calls.findIndex((item) => item.id === frame.toolId);
          const toolCalls = [...calls];
          if (at < 0) toolCalls.push(tool);
          else toolCalls[at] = tool;
          return { ...base, turnId: frame.turnId, toolCalls, activityAnchor: base.activityAnchor ?? base.text.length };
        }),
      };
      break;
    }
    case 'approval': {
      const state = frame.state ?? 'pending';
      const id = `voice-approval:${projection.callId}:${frame.approvalId ?? frame.turnId}`;
      next = {
        ...next,
        messages: updateMessage(next.messages, id, () => textMessage(
          id,
          frame.turnId,
          `Approval ${state}: ${frame.summary}`,
        )),
      };
      break;
    }
    case 'phase':
      // Phase belongs to the call banner, not the conversation: a thread bubble
      // per listening/speaking change is noise between the real turns.
      break;
    case 'call':
      if (frame.state === 'ended' || frame.state === 'ending') {
        const id = `voice-end:${projection.callId}`;
        next = { ...next, messages: updateMessage(next.messages, id, () => textMessage(id, undefined, `Call ${frame.state}`)) };
      }
      break;
    case 'ended':
      {
        const id = `voice-end:${projection.callId}`;
        next = { ...next, messages: updateMessage(next.messages, id, () => textMessage(id, undefined, `Call ended: ${frame.reason}`)) };
      }
      break;
    case 'turn':
      if (frame.state === 'done' || frame.state === 'failed') {
        const id = `voice-reply:${projection.callId}:${frame.turnId}`;
        next = {
          ...next,
          messages: updateMessage(next.messages, id, (prior) => ({
            ...(prior ?? textMessage(id, frame.turnId, '', 'assistant')),
            streaming: false,
            ...(frame.state === 'failed' && frame.error ? { interrupted: true, interruptedReason: frame.error } : {}),
          })),
        };
      }
      break;
    default:
      break;
  }
  return next;
}

/** Canonical rows replace optimistic voice rows once history identifies their turn. */
function matchCallHistory(
  projection: Pick<CallThreadProjection, 'messages' | 'historyBeforeCall' | 'ended'>,
  history: readonly ChatMessage[],
): Map<string, number> {
  const positions = new Map<string, number>();
  const key = (turnId: string, role: ChatMessage['role']) => JSON.stringify([turnId, role]);
  history.forEach((row, index) => positions.set(key(row.turnId ?? row.id, row.role), index));
  const baseline = projection.historyBeforeCall;
  // A page fetched during the call can contain IDs we had never seen, but
  // those on the older side of the baseline are not new call messages.
  let anchor = history.length - 1;
  while (anchor >= 0 && !baseline?.has(history[anchor].id)) anchor -= 1;
  const native = baseline
    ? history.slice(anchor + 1)
    : [];
  const persisted = new Map<string, number>();
  let nextUser = 0;
  for (const live of projection.messages) {
    if (live.role !== 'user') continue;
    const index = native.findIndex((row, at) => at >= nextUser && row.role === 'user' && row.text.trim() === live.text.trim());
    if (index < 0) continue;
    persisted.set(live.id, anchor + index + 1);
    let end = index + 1;
    while (end < native.length && native[end].role !== 'user') end += 1;
    nextUser = end;
    const answer = projection.messages.find((row) => row.id === live.id.replace(/^voice:/, 'voice-reply:'));
    // Backend IDs are not Gate turn IDs. Once the utterance is located in the
    // post-start native history, prefer its reply on settlement (including a
    // reply suffix recovered after a frame gap). Keep a still-streaming answer.
    let replyAt = end - 1;
    while (replyAt > index && (native[replyAt].role !== 'assistant' || !native[replyAt].text.trim())) replyAt -= 1;
    if (answer && (!answer.streaming || projection.ended) && replyAt > index) {
      persisted.set(answer.id, anchor + 1 + replyAt);
    }
  }
  const seenUserRows = new Set(projection.messages.filter((row) => row.role === 'user').map((row) => row.id));
  const claimed = new Set(persisted.values());
  if (baseline && projection.ended) {
    for (const live of projection.messages) {
      // If the committed frame itself was dropped, history can still heal an
      // unambiguous full reply. Do not consume an old or repeated answer.
      if (!live.id.startsWith('voice-reply:') || seenUserRows.has(live.id.replace(/^voice-reply:/, 'voice:'))
        || !live.text.trim()) continue;
      const candidates = native.flatMap((row, index) => row.role === 'assistant' && row.text.trim() === live.text.trim()
        && !claimed.has(anchor + 1 + index) ? [anchor + 1 + index] : []);
      if (candidates.length === 1) {
        persisted.set(live.id, candidates[0]);
        claimed.add(candidates[0]);
      }
    }
  }
  for (const live of projection.messages) {
    // Authoritative stable turn identity, when the backend supplies it, wins.
    const position = live.turnId ? positions.get(key(live.turnId, live.role)) : undefined;
    if (position !== undefined) persisted.set(live.id, position);
  }
  return persisted;
}

function transientAfterCall(message: ChatMessage, ended?: boolean) {
  return ended && (message.id.startsWith('voice-end:') || message.id.startsWith('voice-approval:')
    || (message.id.startsWith('voice-reply:') && !message.text.trim()));
}

export function reconcileCallThreadProjection(
  projection: Pick<CallThreadProjection, 'messages' | 'historyBeforeCall' | 'ended'>,
  history: readonly ChatMessage[],
): ChatMessage[] {
  const matched = matchCallHistory(projection, history);
  return projection.messages.filter((message) => !matched.has(message.id) && !transientAfterCall(message, projection.ended));
}

/** Keep a locally projected row at its original place if a later row has already persisted. */
export function mergeCallThreadTranscript(
  projection: Pick<CallThreadProjection, 'threadKey' | 'messages' | 'historyBeforeCall' | 'ended'> | null,
  threadKey: string | undefined,
  history: ChatMessage[],
): ChatMessage[] {
  if (!projection || !threadKey || projection.threadKey !== threadKey) return history;
  const matched = matchCallHistory(projection, history);
  const inserts = new Map<number, ChatMessage[]>();
  let next = history.length;
  for (let i = projection.messages.length - 1; i >= 0; i -= 1) {
    const row = projection.messages[i];
    const index = matched.get(row.id);
    if (index !== undefined) next = index;
    else if (!transientAfterCall(row, projection.ended)) {
      const group = inserts.get(next) ?? [];
      group.push(row);
      inserts.set(next, group);
    }
  }
  if (!inserts.size) return history;
  const out = history.flatMap((row, index) => {
    const before = inserts.get(index);
    return before ? [...before.reverse(), row] : [row];
  });
  return out.concat(inserts.get(history.length)?.reverse() ?? []);
}

/** A route can consume call rows only while it is showing the call's captured thread. */
export function callProjectionForThread(
  projection: Pick<CallThreadProjection, 'threadKey' | 'messages' | 'historyBeforeCall' | 'ended'> | null,
  threadKey: string | undefined,
  history: readonly ChatMessage[],
): ChatMessage[] {
  if (!projection || !threadKey || projection.threadKey !== threadKey) return [];
  return reconcileCallThreadProjection(projection, history);
}
