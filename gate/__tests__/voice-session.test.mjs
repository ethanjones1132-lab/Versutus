import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INITIAL_VOICE_SESSION, reduceVoiceSession } from '../core/voice/voice-session.mjs';
import { speechChunks } from '../core/voice/sentences.mjs';

function run(events, state = INITIAL_VOICE_SESSION) {
  let current = state;
  const effects = [];
  for (const event of events) {
    const out = reduceVoiceSession(current, event);
    current = out.state;
    effects.push(...out.effects);
  }
  return { state: current, effects };
}

const listening = () => run([{ type: 'ready' }]).state;
const speaking = () =>
  run([{ type: 'final', text: 'Hello there.' }, { type: 'replyDelta', text: 'Hi.' }], listening());

test('a turn moves listening → thinking → speaking → listening', () => {
  const start = listening();
  assert.equal(start.phase, 'listening');

  const thinking = run([{ type: 'final', text: 'Hello there.' }], start);
  assert.equal(thinking.state.phase, 'thinking');
  assert.ok(thinking.effects.some((e) => e.kind === 'turn.run' && e.text === 'Hello there.'));

  const said = run([{ type: 'replyDelta', text: 'Hi.' }], thinking.state);
  assert.equal(said.state.phase, 'speaking');
  assert.ok(said.effects.some((e) => e.kind === 'engine.speak' && e.text === 'Hi.'));
  assert.ok(said.effects.some((e) => e.kind === 'send' && e.frame.t === 'phase' && e.frame.phase === 'speaking'));

  const done = run([{ type: 'speechDone', gen: said.state.gen }], said.state);
  assert.equal(done.state.phase, 'listening');
  assert.ok(done.effects.some((e) => e.kind === 'send' && e.frame.t === 'phase' && e.frame.phase === 'listening'));
});

test('barge-in cancels only the generation being spoken', () => {
  const live = speaking();
  const gen = live.state.gen;
  const barged = run([{ type: 'bargein' }], live.state);
  assert.equal(barged.state.phase, 'listening');
  assert.ok(barged.effects.some((e) => e.kind === 'engine.cancelSpeech' && e.gen === gen));

  // The cancelled generation's late speechDone cannot move the loop.
  const late = run([{ type: 'speechDone', gen }], barged.state);
  assert.equal(late.state.phase, 'listening');
  assert.equal(late.effects.length, 0);
});

test('skip stops the turn and reopens listening', () => {
  const live = speaking();
  const skipped = run([{ type: 'skip' }], live.state);
  assert.equal(skipped.state.phase, 'listening');
  assert.ok(skipped.effects.some((e) => e.kind === 'turn.cancel'));
  assert.ok(skipped.effects.some((e) => e.kind === 'engine.cancelSpeech'));
});

test('mute and unmute pass through the engine', () => {
  const muted = run([{ type: 'mute' }], listening());
  assert.equal(muted.state.phase, 'muted');
  assert.ok(muted.effects.some((e) => e.kind === 'engine.setMuted' && e.muted === true));

  const back = run([{ type: 'unmute' }], muted.state);
  assert.equal(back.state.phase, 'listening');
  assert.ok(back.effects.some((e) => e.kind === 'engine.setMuted' && e.muted === false));
});

test('a failed turn speaks a short line and returns to listening', () => {
  const thinking = run([{ type: 'final', text: 'x' }], listening());
  const failed = run([{ type: 'replyFailed', message: 'boom' }], thinking.state);
  assert.equal(failed.state.phase, 'speaking');
  assert.ok(failed.effects.some((e) => e.kind === 'engine.speak'));
  assert.ok(failed.effects.some((e) => e.kind === 'send' && e.frame.t === 'turn' && e.frame.state === 'failed'));

  const done = run([{ type: 'speechDone', gen: failed.state.gen }], failed.state);
  assert.equal(done.state.phase, 'listening');
});

test('an empty turn also speaks the failure line rather than hanging', () => {
  const thinking = run([{ type: 'final', text: 'x' }], listening());
  const empty = run([{ type: 'replyDone' }], thinking.state);
  assert.equal(empty.state.phase, 'speaking');
  assert.ok(empty.effects.some((e) => e.kind === 'engine.speak'));
});

test('end from the phone ends the call exactly once', () => {
  const ended = run([{ type: 'end' }], listening());
  assert.equal(ended.state.phase, 'ending');
  assert.equal(ended.effects.filter((e) => e.kind === 'send' && e.frame.t === 'ended').length, 1);
  assert.ok(ended.effects.some((e) => e.kind === 'audit'));

  const again = run([{ type: 'end' }, { type: 'error', fatal: true }, { type: 'socketClosed' }], ended.state);
  assert.equal(again.effects.length, 0);
});

test('the sentence chunker cuts where the app cuts', () => {
  assert.deepEqual(speechChunks('One. Two! Three?', 100), ['One. Two! Three?']);
  assert.deepEqual(speechChunks('One. Two.', 5), ['One. ', 'Two.']);
  assert.deepEqual(speechChunks('', 100), []);
});
