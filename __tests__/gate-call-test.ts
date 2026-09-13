import { readFileSync } from 'fs';
import { join } from 'path';

import {
  INITIAL_GATE_CALL,
  appPhaseForGate,
  gateControlFor,
  reduceGateCall,
  serializeGateControl,
} from '@/lib/voice/gate-call';
import { parsePhoneFrame } from '@/lib/voice/voice-stream-protocol';

const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'gate', '__tests__', 'fixtures', 'voice-protocol.json'), 'utf8'),
) as { gateToPhone: unknown[] };

describe('reduceGateCall folds every Gate frame into the banner', () => {
  test('every frame in the shared fixture folds without throwing', () => {
    const phaseOf = (input: unknown) =>
      reduceGateCall(INITIAL_GATE_CALL, input as never).state.phase;
    for (const frame of fixture.gateToPhone) {
      expect(phaseOf(frame)).toBeTruthy();
    }
  });

  test('ready records the engine the Gate actually used', () => {
    const { state } = reduceGateCall(INITIAL_GATE_CALL, '{"t":"ready","engine":"local"}');
    expect(state.engine).toBe('local');
  });

  test('phase tracks listening, thinking, speaking and muted', () => {
    for (const phase of ['listening', 'thinking', 'speaking', 'muted'] as const) {
      const { state } = reduceGateCall(INITIAL_GATE_CALL, { t: 'phase', phase });
      expect(state.phase).toBe(phase);
    }
  });

  test('partial is the live transcript and a final is recovery, not a send', () => {
    const spoken = reduceGateCall(INITIAL_GATE_CALL, { t: 'partial', text: 'hel' }).state;
    expect(spoken.partial).toBe('hel');
    const done = reduceGateCall(spoken, { t: 'final', turnId: 't1', text: 'hello' });
    expect(done.state.recovery).toBe('hello');
    expect(done.state.partial).toBe('');
    expect(done.effects.some((effect) => effect.kind === 'send-control')).toBe(false);
  });

  test('reply deltas accumulate and move the banner to speaking', () => {
    const first = reduceGateCall(INITIAL_GATE_CALL, { t: 'reply', turnId: 't1', delta: 'Hi' }).state;
    const second = reduceGateCall(first, { t: 'reply', turnId: 't1', delta: ' there' }).state;
    expect(second.reply).toBe('Hi there');
    expect(second.phase).toBe('speaking');
  });

  test('a turn done clears the banner and asks the chat to reload', () => {
    const speaking = reduceGateCall(INITIAL_GATE_CALL, { t: 'reply', turnId: 't1', delta: 'Hi' }).state;
    const { state, effects } = reduceGateCall(speaking, { t: 'turn', turnId: 't1', state: 'done' });
    expect(state.turnState).toBe('done');
    expect(state.reply).toBe('');
    expect(effects).toEqual([{ kind: 'reload-history' }]);
  });

  test('a failed turn names its error without ending the call', () => {
    const { state } = reduceGateCall(INITIAL_GATE_CALL, {
      t: 'turn',
      turnId: 't1',
      state: 'failed',
      error: 'backend_error',
    });
    expect(state.turnState).toBe('failed');
    expect(state.turnError).toBe('backend_error');
    expect(state.phase).not.toBe('ended');
  });

  test('speech generations are tracked so playback can follow them', () => {
    const { state } = reduceGateCall(INITIAL_GATE_CALL, { t: 'speech', gen: 7, state: 'start' });
    expect(state.speechGen).toBe(7);
    expect(state.speechState).toBe('start');
  });

  test('an approval frame is surfaced for the approval flow', () => {
    const { state } = reduceGateCall(INITIAL_GATE_CALL, {
      t: 'approval',
      turnId: 't1',
      summary: 'Run ls?',
    });
    expect(state.approval).toEqual({ turnId: 't1', summary: 'Run ls?' });
  });
});

describe('a Gate call ends exactly once and never sends for the operator', () => {
  test('an ended frame ends the call and a later frame changes nothing', () => {
    const first = reduceGateCall(INITIAL_GATE_CALL, { t: 'ended', reason: 'user' });
    expect(first.state.phase).toBe('ended');
    expect(first.state.endedReason).toBe('user');
    expect(first.effects).toEqual([{ kind: 'ended', reason: 'user' }]);

    const second = reduceGateCall(first.state, { t: 'ended', reason: 'user' });
    expect(second.state).toBe(first.state);
    expect(second.effects).toEqual([]);
  });

  test('a fatal error ends the call once and non-fatal errors do not', () => {
    const fatal = reduceGateCall(INITIAL_GATE_CALL, {
      t: 'error',
      code: 'engine_error',
      message: 'boom',
      fatal: true,
    });
    expect(fatal.state.phase).toBe('ended');
    expect(fatal.effects).toEqual([{ kind: 'ended', reason: 'engine_error' }]);

    const soft = reduceGateCall(INITIAL_GATE_CALL, {
      t: 'error',
      code: 'engine_error',
      message: 'blip',
      fatal: false,
    });
    expect(soft.state.phase).toBe('opening');
    expect(soft.effects).toEqual([]);
  });

  test('an unknown or unparseable frame is inert, not fatal', () => {
    for (const input of ['{"t":"nope"}', 'not json', '{"t":"partial"}']) {
      const { state, effects } = reduceGateCall(INITIAL_GATE_CALL, input);
      expect(state).toBe(INITIAL_GATE_CALL);
      expect(effects).toEqual([]);
    }
  });

  test('recovery text is held, and no frame path ever emits a send', () => {
    let state = INITIAL_GATE_CALL;
    for (const frame of fixture.gateToPhone) {
      const next = reduceGateCall(state, frame as never);
      state = next.state;
      expect(next.effects.some((effect) => effect.kind === 'send-control')).toBe(false);
    }
  });
});

describe('phone → Gate control frames', () => {
  test('each action maps to the frame the Gate parses', () => {
    expect(gateControlFor('mute')).toEqual({ t: 'mute', on: true });
    expect(gateControlFor('unmute')).toEqual({ t: 'mute', on: false });
    expect(gateControlFor('skip')).toEqual({ t: 'skip' });
    expect(gateControlFor('end')).toEqual({ t: 'end' });
  });

  test('serialized controls round-trip through the shared phone parser', () => {
    for (const action of ['mute', 'unmute', 'skip', 'end'] as const) {
      expect(parsePhoneFrame(serializeGateControl(gateControlFor(action)))).toEqual(
        gateControlFor(action),
      );
    }
  });
});

describe('the Gate banner speaks the app phase vocabulary', () => {
  test('every Gate phase maps to a phase the banner already draws', () => {
    expect(appPhaseForGate('opening')).toBe('starting');
    expect(appPhaseForGate('listening')).toBe('listening');
    expect(appPhaseForGate('thinking')).toBe('sending');
    expect(appPhaseForGate('speaking')).toBe('speaking');
    expect(appPhaseForGate('muted')).toBe('muted');
    expect(appPhaseForGate('ended')).toBe('ended');
  });
});
