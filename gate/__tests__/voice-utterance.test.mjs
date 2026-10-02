import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INITIAL_VOICE_SESSION, reduceVoiceSession } from '../core/voice/voice-session.mjs';

// The reducer's own clocks: how long the person is given to finish a sentence,
// and how long a final heard while a turn is thinking still counts as the same
// thought. A hold of 0 is the older behaviour (one final, one turn, at once).
const HOLD = 1400;
const CONTINUATION = 4000;

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

const listening = ({ holdMs = HOLD, continuationMs = CONTINUATION } = {}) =>
  run([{ type: 'ready', turnId: 'vs-1', utteranceHoldMs: holdMs, continuationMs }]).state;

/** The sentences of the measured call: one person, seven segments, one thought. */
const SEGMENTS = [
  'what is the',
  'weather like',
  'in glasgow',
  'tomorrow morning',
  'and should i',
  'bring an umbrella',
  'thank you',
];
const UTTERANCE = SEGMENTS.join(' ');

const texts = (effects, kind) => effects.filter((e) => e.kind === kind).map((e) => e.text);
const frames = (effects, t) => effects.filter((e) => e.kind === 'send' && e.frame.t === t).map((e) => e.frame);

test('three finals in a row make one turn, sent after the hold, with a growing transcript', () => {
  const first = run([{ type: 'final', text: SEGMENTS[0], nowMs: 0 }], listening());
  assert.equal(first.state.phase, 'listening', 'a final alone does not start a turn');
  assert.equal(first.state.pendingText, SEGMENTS[0]);
  assert.deepEqual(frames(first.effects, 'partial'), [{ t: 'partial', text: SEGMENTS[0] }]);
  assert.ok(first.effects.some((e) => e.kind === 'hold.start' && e.ms === HOLD));
  assert.equal(first.effects.some((e) => e.kind === 'turn.run'), false);

  const second = run([{ type: 'final', text: SEGMENTS[1], nowMs: 1_500 }], first.state);
  const third = run([{ type: 'final', text: SEGMENTS[2], nowMs: 3_000 }], second.state);
  assert.equal(third.state.pendingText, SEGMENTS.slice(0, 3).join(' '));
  // The phone is shown the whole utterance as it is gathered, not just the
  // segment that arrived last.
  assert.deepEqual(
    frames(third.effects, 'partial').map((f) => f.text),
    [SEGMENTS.slice(0, 3).join(' ')],
  );

  const held = run([{ type: 'holdElapsed', nowMs: 4_400 }], third.state);
  assert.equal(held.state.phase, 'thinking');
  assert.deepEqual(texts(held.effects, 'turn.run'), [SEGMENTS.slice(0, 3).join(' ')]);
  assert.deepEqual(frames(held.effects, 'final').map((f) => f.text), [SEGMENTS.slice(0, 3).join(' ')]);
  assert.deepEqual(
    held.effects.filter((e) => e.kind === 'utterance.commit').map((e) => [e.chars, e.finals]),
    [[SEGMENTS.slice(0, 3).join(' ').length, 3]],
    'one utterance of three finals is committed',
  );
  assert.equal(held.state.pendingText, '');
  assert.equal(held.state.committedText, SEGMENTS.slice(0, 3).join(' '));
});

test('a partial inside the hold restarts it, because the person is still talking', () => {
  const pending = run([{ type: 'final', text: 'what is the', nowMs: 0 }], listening());
  // The recognizer's live partial covers the segment it is transcribing now: the
  // phone is shown that segment joined onto the ones already heard, and the hold
  // starts again so the sentence is not cut short.
  const heard = run([{ type: 'partial', text: 'weather li', nowMs: 500 }], pending.state);
  assert.ok(heard.effects.some((e) => e.kind === 'hold.start' && e.ms === HOLD));
  assert.deepEqual(frames(heard.effects, 'partial').map((f) => f.text), ['what is the weather li']);
  // The segment is not committed by its partial: its final is what joins.
  assert.equal(heard.state.pendingText, 'what is the');
  assert.equal(heard.state.phase, 'listening');

  const done = run([{ type: 'final', text: 'weather like', nowMs: 900 }], heard.state);
  assert.equal(done.state.pendingText, 'what is the weather like');
});

test('a new speech start inside the hold restarts it too', () => {
  const pending = run([{ type: 'final', text: 'what is the', nowMs: 0 }], listening());
  const still = run([{ type: 'userSpeechStart' }], pending.state);
  assert.ok(still.effects.some((e) => e.kind === 'hold.start' && e.ms === HOLD));
  assert.equal(still.effects.some((e) => e.kind === 'turn.run'), false);
  assert.equal(still.effects.some((e) => e.kind === 'turn.cancel'), false);
});

test('a hold with nothing pending is inert', () => {
  const idle = run([{ type: 'holdElapsed', nowMs: 1_000 }], listening());
  assert.equal(idle.effects.length, 0);
  assert.equal(idle.state.phase, 'listening');
});

test('a mute taken mid-hold holds the utterance with it, and unmute sends it', () => {
  const pending = run([{ type: 'final', text: 'what is the', nowMs: 0 }], listening());
  const muted = run([{ type: 'mute' }], pending.state);
  assert.equal(muted.state.phase, 'muted');
  // The hold elapsed while the mic was shut: it cannot send yet.
  const held = run([{ type: 'holdElapsed', nowMs: 1_500 }], muted.state);
  assert.equal(held.effects.length, 0);
  assert.equal(held.state.pendingText, 'what is the');

  const back = run([{ type: 'unmute' }], held.state);
  assert.ok(back.effects.some((e) => e.kind === 'hold.start' && e.ms === HOLD));
});

test('a final during thinking, before any reply and inside the window, is the same thought', () => {
  const committed = run([{ type: 'final', text: 'what is the', nowMs: 0 }, { type: 'holdElapsed', nowMs: 1_400 }], listening());
  assert.equal(committed.state.phase, 'thinking');

  const more = run([{ type: 'final', text: 'weather in glasgow', nowMs: 3_000 }], committed.state);
  assert.equal(more.state.phase, 'listening', 'the turn goes back to listening to gather the rest');
  assert.ok(more.effects.some((e) => e.kind === 'turn.cancel'), 'the unanswered turn is cancelled');
  assert.equal(more.state.pendingText, 'what is the weather in glasgow');
  assert.ok(more.effects.some((e) => e.kind === 'utterance.merge' && e.chars === 'weather in glasgow'.length));

  const merged = run([{ type: 'holdElapsed', nowMs: 4_400 }], more.state);
  assert.deepEqual(texts(merged.effects, 'turn.run'), ['what is the weather in glasgow']);
});

test('a final after the window waits for its own turn instead of restarting one', () => {
  const committed = run([{ type: 'final', text: 'what is the', nowMs: 0 }, { type: 'holdElapsed', nowMs: 1_400 }], listening());
  const late = run([{ type: 'final', text: 'and tomorrow', nowMs: 6_000 }], committed.state);
  assert.equal(late.state.phase, 'thinking', 'the running turn keeps its answer');
  assert.equal(late.effects.some((e) => e.kind === 'turn.cancel'), false);
  assert.deepEqual(late.state.queued, ['and tomorrow']);
  assert.ok(late.effects.some((e) => e.kind === 'utterance.queue' && e.chars === 12));
});

test('several finals heard while the reply is spoken go as one turn when it ends', () => {
  const first = run([{ type: 'final', text: 'what is the', nowMs: 0 }, { type: 'holdElapsed', nowMs: 1_400 }], listening());
  const said = run([{ type: 'replyDelta', text: 'It is raining.' }], first.state);
  const heard = run(
    [
      { type: 'final', text: 'also', nowMs: 2_000 },
      { type: 'final', text: 'should I bring', nowMs: 2_800 },
      { type: 'final', text: 'an umbrella', nowMs: 3_600 },
    ],
    said.state,
  );
  assert.deepEqual(heard.state.queued, ['also', 'should I bring', 'an umbrella']);
  assert.equal(heard.effects.some((e) => e.kind === 'turn.run'), false, 'the reply is not interrupted');

  const done = run([{ type: 'speechDone', gen: heard.state.gen, nowMs: 9_000 }], heard.state);
  assert.equal(done.state.phase, 'thinking');
  assert.deepEqual(texts(done.effects, 'turn.run'), ['also should I bring an umbrella'], 'one merged turn');
  assert.deepEqual(done.state.queued, [], 'nothing is left waiting, so none is sent twice');
  assert.deepEqual(
    done.effects.filter((e) => e.kind === 'utterance.commit').map((e) => e.finals),
    [3],
  );

  // The follow-up turn runs to its own end with nothing left queued.
  const replied = run([{ type: 'replyDelta', text: 'Yes, bring one.' }], done.state);
  const quiet = run([{ type: 'speechDone', gen: replied.state.gen, nowMs: 20_000 }], replied.state);
  assert.equal(quiet.state.phase, 'listening');
  assert.equal(quiet.effects.some((e) => e.kind === 'turn.run'), false, 'the queued words are sent once');
});

test('partials while a turn runs are forwarded, so the live transcript does not freeze', () => {
  const thinking = run([{ type: 'final', text: 'what is the', nowMs: 0 }, { type: 'holdElapsed', nowMs: 1_400 }], listening());
  const live = run([{ type: 'partial', text: 'what is the wea', nowMs: 2_000 }], thinking.state);
  assert.deepEqual(frames(live.effects, 'partial').map((f) => f.text), ['what is the wea']);

  const speaking = run([{ type: 'replyDelta', text: 'It is raining.' }], thinking.state);
  const still = run([{ type: 'partial', text: 'and tomor', nowMs: 2_400 }], speaking.state);
  assert.deepEqual(frames(still.effects, 'partial').map((f) => f.text), ['and tomor']);
});

test('speaking over a turn that is still thinking drops nothing', () => {
  const thinking = run([{ type: 'final', text: 'what is the', nowMs: 0 }, { type: 'holdElapsed', nowMs: 1_400 }], listening());
  const spoke = run([{ type: 'userSpeechStart' }], thinking.state);
  assert.equal(spoke.effects.length, 0, 'nothing is cancelled: nothing is being spoken yet');
  assert.equal(spoke.state.phase, 'thinking', 'the reply is still owed');

  const said = run([{ type: 'replyDelta', text: 'It is raining.' }], spoke.state);
  const heard = run([{ type: 'final', text: 'in glasgow too', nowMs: 5_000 }], said.state);
  assert.deepEqual(heard.state.queued, ['in glasgow too'], 'the words wait rather than vanish');
});

test('barge-in from speaking still cancels the speech, and its words then go through the hold', () => {
  const live = run(
    [
      { type: 'final', text: 'turn one', nowMs: 0 },
      { type: 'holdElapsed', nowMs: 1_400 },
      { type: 'replyDelta', text: 'A long reply.' },
    ],
    listening(),
  );
  const barged = run([{ type: 'userSpeechStart' }], live.state);
  assert.equal(barged.state.phase, 'listening');
  assert.ok(barged.effects.some((e) => e.kind === 'engine.cancelSpeech' && e.gen === live.state.gen));

  const words = run([{ type: 'final', text: 'turn two', nowMs: 8_000 }], barged.state);
  assert.equal(words.state.pendingText, 'turn two');
  const sent = run([{ type: 'holdElapsed', nowMs: 9_400 }], words.state);
  assert.deepEqual(texts(sent.effects, 'turn.run'), ['turn two']);
});

test('merging a second segment ends a speculative turn, so one utterance is never two live turns', () => {
  // The engine named the turn early: the backend is already answering the first
  // segment. The second segment means it was answering half a sentence.
  const guessed = run([{ type: 'final', text: SEGMENTS[0], nowMs: 0 }], listening());
  const more = run([{ type: 'final', text: SEGMENTS[1], nowMs: 1_000 }], guessed.state);
  assert.ok(more.effects.some((e) => e.kind === 'turn.cancel'), 'the guess is ended');
  const sent = run([{ type: 'holdElapsed', nowMs: 2_400 }], more.state);
  assert.deepEqual(texts(sent.effects, 'turn.run'), [SEGMENTS.slice(0, 2).join(' ')]);
});

test('a hold of 0 commits every segment at once, as the loop did before', () => {
  const immediate = listening({ holdMs: 0 });
  const first = run([{ type: 'final', text: SEGMENTS[0], nowMs: 0 }], immediate);
  assert.equal(first.state.phase, 'thinking');
  assert.deepEqual(texts(first.effects, 'turn.run'), [SEGMENTS[0]]);
  assert.equal(first.effects.some((e) => e.kind === 'hold.start'), false);

  // With no hold the committed text is exactly the segment, so a speculative
  // turn started from it is still promoted rather than restarted.
  assert.equal(first.state.committedText, SEGMENTS[0]);
});

test('the whole measured call is one utterance when every segment lands inside the hold', () => {
  let state = listening();
  const effects = [];
  SEGMENTS.forEach((text, index) => {
    const out = reduceVoiceSession(state, { type: 'final', text, nowMs: index * 1_500 });
    state = out.state;
    effects.push(...out.effects);
  });
  assert.equal(state.pendingText, UTTERANCE);
  assert.equal(effects.filter((e) => e.kind === 'turn.run').length, 0, 'no turn until the person stops');

  const held = reduceVoiceSession(state, { type: 'holdElapsed', nowMs: 11_900 });
  assert.deepEqual(texts(held.effects, 'turn.run'), [UTTERANCE]);
  assert.deepEqual(held.effects.filter((e) => e.kind === 'utterance.commit').map((e) => e.finals), [7]);
});
