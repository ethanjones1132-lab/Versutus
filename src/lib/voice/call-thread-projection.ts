import type { ChatMessage, ChatToolCall } from '@/lib/gateway/types';
import type { GateVoiceFrame } from '@/lib/voice/voice-stream-protocol';

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
    if (frame.seq <= projection.lastSeq || frame.seq !== projection.lastSeq + 1) return projection;
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
      const offset = frame.offset ?? next.replyOffsets[frame.turnId] ?? prior?.text.length ?? 0;
      // Offsets make retransmitted or overlapping deltas idempotent. A gap is
      // left unfilled rather than inventing text the Gate did not send.
      if (offset <= (prior?.text.length ?? 0)) {
        const existingText = prior?.text ?? '';
        const overlap = Math.max(0, Math.min(frame.delta.length, existingText.length - offset));
        const suffix = frame.delta.slice(overlap);
        if (!suffix) break;
        const text = `${existingText.slice(0, offset + overlap)}${suffix}`;
        next = {
          ...next,
          messages: updateMessage(next.messages, id, () => ({
            ...(prior ?? textMessage(id, frame.turnId, '', 'assistant')),
            text,
            turnId: frame.turnId,
            streaming: true,
          })),
          replyOffsets: { ...next.replyOffsets, [frame.turnId]: Math.max(offset + frame.delta.length, existingText.length) },
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
export function reconcileCallThreadProjection(
  projection: CallThreadProjection,
  history: readonly ChatMessage[],
): ChatMessage[] {
  const canonicalRoles = new Map<string, Set<ChatMessage['role']>>();
  for (const message of history) {
    const turnId = message.turnId ?? message.id;
    const roles = canonicalRoles.get(turnId) ?? new Set<ChatMessage['role']>();
    roles.add(message.role);
    canonicalRoles.set(turnId, roles);
  }
  return projection.messages.filter((message) => !message.turnId || !canonicalRoles.get(message.turnId)?.has(message.role));
}

/** A route can consume call rows only while it is showing the call's captured thread. */
export function callProjectionForThread(
  projection: { threadKey: string; messages: ChatMessage[] } | null,
  threadKey: string | undefined,
  history: readonly ChatMessage[],
): ChatMessage[] {
  if (!projection || !threadKey || projection.threadKey !== threadKey) return [];
  return reconcileCallThreadProjection({
    threadKey,
    callId: '',
    lastSeq: 0,
    messages: projection.messages,
    replyOffsets: {},
  }, history);
}
