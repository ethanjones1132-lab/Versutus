import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INITIAL_VOICE_SESSION, reduceVoiceSession } from '../core/voice/voice-session.mjs';

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

const listening = () => run([{ type: 'ready', turnId: 'vs-mute' }]).state;

/** A turn that has answered one delta and is still speaking. */
const speaking = () => run(
  [{ type: 'final', text: 'Hello there.' }, { type: 'replyDelta', text: 'Hi.' }],
  listening(),
).state;

const says = (effects) => effects.filter((e) => e.kind === 'engine.speak');
const frames = (effects, t) => effects
  .filter((e) => e.kind === 'send' && e.frame.t === t)
  .map((e) => e.frame);

test('a mute during the reply does not drop the rest of it', () => {
  const muted = run([{ type: 'mute' }], speaking());
  assert.equal(muted.state.phase, 'muted');
  assert.equal(muted.state.resumePhase, 'speaking');

  // The turn is still running while the phone is muted: its deltas belong to the
  // phone even though none of them may be spoken aloud.
  const more = run([{ type: 'replyDelta', text: ' There.' }], muted.state);
  assert.equal(more.state.phase, 'muted');
  assert.equal(more.state.reply, 'Hi. There.');
  assert.deepEqual(frames(more.effects, 'reply').map((f) => f.delta), [' There.']);
  assert.equal(says(more.effects).length, 0, 'a muted call speaks nothing');
});

test('a muted turn still delivers its done frame, and unmute reopens listening', () => {
  const muted = run([{ type: 'mute' }], speaking());
  const more = run([{ type: 'replyDelta', text: ' There.' }], muted.state);
  const done = run([{ type: 'replyDone' }], more.state);

  assert.equal(done.state.phase, 'muted', 'the call is still muted');
  assert.deepEqual(frames(done.effects, 'turn').map((f) => f.state), ['done']);
  assert.equal(says(done.effects).length, 0);
  assert.equal(done.state.reply, '');
  assert.equal(done.state.resumePhase, 'listening', 'the finished turn leaves listening as the resume phase');

  const back = run([{ type: 'unmute' }], done.state);
  assert.equal(back.state.phase, 'listening');
  assert.equal(back.state.muted, false);
});

test('a mute mid-speech still reports the end of that speech', () => {
  const live = speaking();
  const muted = run([{ type: 'mute' }], live);

  // The audio already playing when the mute landed still ends, and the phone is
  // told so; the call itself stays muted and listening does not reopen.
  const ended = run([{ type: 'speechDone', gen: live.gen }], muted.state);
  assert.equal(ended.state.phase, 'muted');
  assert.deepEqual(frames(ended.effects, 'speech').map((f) => f.state), ['end']);
  assert.equal(ended.effects.some((e) => e.kind === 'send' && e.frame.t === 'phase'), false);

  // A stale generation is still ignored, exactly as it is when unmuted.
  const late = run([{ type: 'speechDone', gen: live.gen - 1 }], muted.state);
  assert.equal(late.effects.length, 0);
});

test('a reply that fails while muted still tells the phone', () => {
  const muted = run([{ type: 'mute' }], speaking());
  const failed = run([{ type: 'replyFailed', message: 'backend fell over' }], muted.state);

  assert.equal(failed.state.phase, 'muted');
  const turn = frames(failed.effects, 'turn');
  assert.deepEqual(turn.map((f) => f.state), ['failed']);
  assert.equal(turn[0].error, 'backend fell over');
  assert.equal(says(failed.effects).length, 0, 'the spoken failure line is suppressed while muted');
  assert.equal(failed.state.resumePhase, 'listening');
});

test('unmuting mid-reply resumes at the next sentence instead of replaying muted text', () => {
  const muted = run([{ type: 'mute' }], speaking());
  const more = run([{ type: 'replyDelta', text: ' There.' }], muted.state);
  assert.deepEqual(frames(more.effects, 'reply').map((f) => f.delta), [' There.']);

  const back = run([{ type: 'unmute' }], more.state);
  assert.equal(back.state.phase, 'speaking');

  const resumed = run([{ type: 'replyDelta', text: ' Done.' }], back.state);
  assert.deepEqual(says(resumed.effects).map((e) => e.text), [' Done.']);
});

test('an unmuted turn still speaks every completed sentence', () => {
  const thinking = run([{ type: 'final', text: 'Hello there.' }], listening());
  const said = run([{ type: 'replyDelta', text: 'First. Second' }], thinking.state);
  assert.deepEqual(says(said.effects).map((e) => e.text), ['First. ']);

  const done = run([{ type: 'replyDone' }], said.state);
  assert.deepEqual(says(done.effects).map((e) => e.text), ['Second']);
  assert.deepEqual(frames(done.effects, 'turn').map((f) => f.state), ['done']);

  const ended = run([{ type: 'speechDone', gen: done.state.gen }], done.state);
  assert.equal(ended.state.phase, 'listening');
});
