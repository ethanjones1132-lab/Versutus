import type { ChatMessage } from '@/lib/gateway/types';
import {
  emptyCallThreadProjection,
  projectCallFrame,
  reconcileCallThreadProjection,
} from '@/lib/voice/call-thread-projection';

const frame = <T extends Record<string, unknown>>(t: string, seq: number, fields: T) => ({
  t,
  v: 2 as const,
  callId: 'call-1',
  seq,
  ts: seq,
  ...fields,
});

describe('call thread projection', () => {
  test('projects commits, streamed replies, tools, approvals, phases and the end once', () => {
    let state = emptyCallThreadProjection('gw:bot:bot:session', 'call-1');
    const events = [
      frame('final', 1, { turnId: 'turn-1', text: 'What I said' }),
      frame('reply', 2, { turnId: 'turn-1', offset: 0, delta: 'First' }),
      frame('reply', 3, { turnId: 'turn-1', offset: 5, delta: ' reply' }),
      frame('tool', 4, { turnId: 'turn-1', toolId: 'tool-1', name: 'search', status: 'running', summary: 'Searching' }),
      frame('tool', 5, { turnId: 'turn-1', toolId: 'tool-1', name: 'search', status: 'complete', summary: 'Found results' }),
      frame('approval', 6, { turnId: 'turn-1', approvalId: 'approval-1', state: 'pending', summary: 'Approve access?' }),
      frame('approval', 7, { turnId: 'turn-1', approvalId: 'approval-1', state: 'approved', summary: 'Approve access?' }),
      frame('phase', 8, { phase: 'speaking' }),
      frame('ended', 9, { reason: 'user' }),
    ] as const;
    for (const event of events) state = projectCallFrame(state, event as never);

    expect(state.messages).toHaveLength(5);
    expect(state.messages[0]).toMatchObject({ role: 'user', turnId: 'turn-1', text: 'What I said' });
    expect(state.messages[1]).toMatchObject({ text: 'First reply', streaming: true });
    expect(state.messages[1].toolCalls).toEqual([
      { id: 'tool-1', name: 'search', status: 'complete', detail: 'Found results' },
    ]);
    expect(state.messages[2].text).toContain('Approval approved');
    expect(state.messages[3].text).toBe('Call phase: speaking');
    expect(state.messages[4].text).toBe('Call ended: user');

    // Both sequence replay and the second turn-id guard are harmless.
    const replay = projectCallFrame(state, events[1] as never);
    expect(replay).toBe(state);
    state = projectCallFrame(state, frame('final', 10, { turnId: 'turn-1', text: 'What I said' }) as never);
    expect(state.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(state.lastSeq).toBe(10);
  });

  test('uses UTF-16 offsets to fold overlapping reply replay and rejects another call', () => {
    let state = emptyCallThreadProjection('thread-a', 'call-1');
    state = projectCallFrame(state, frame('reply', 1, { turnId: 'turn-1', offset: 0, delta: 'A😀B' }) as never);
    state = projectCallFrame(state, frame('reply', 2, { turnId: 'turn-1', offset: 3, delta: 'B!' }) as never);
    expect(state.messages[0].text).toBe('A😀B!');
    expect(projectCallFrame(state, { ...frame('phase', 3, { phase: 'thinking' }), callId: 'other' } as never)).toBe(state);
  });

  test('reconciles canonical rows by turn id while retaining unmatched live rows', () => {
    let state = emptyCallThreadProjection('thread-a', 'call-1');
    state = projectCallFrame(state, frame('final', 1, { turnId: 'turn-1', text: 'Hello' }) as never);
    state = projectCallFrame(state, frame('reply', 2, { turnId: 'turn-1', offset: 0, delta: 'Hi' }) as never);
    state = projectCallFrame(state, frame('final', 3, { turnId: 'turn-2', text: 'Still live' }) as never);
    const history: ChatMessage[] = [{ id: 'canonical-1', role: 'user', text: 'Hello', turnId: 'turn-1' }];
    expect(reconcileCallThreadProjection(state, history).map((message) => message.turnId)).toEqual(['turn-1', 'turn-2']);
    const completeHistory: ChatMessage[] = [
      ...history,
      { id: 'canonical-reply', role: 'assistant', text: 'Hi', turnId: 'turn-1' },
    ];
    expect(reconcileCallThreadProjection(state, completeHistory).map((message) => message.turnId)).toEqual(['turn-2']);
  });
});
