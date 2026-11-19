// When is the person done talking? The call used to answer that with a clock: a
// fixed 1.8 s after every final, in case more was coming. An engine that knows
// whether more is coming says so (`hearing`), and the turn is sent a short
// settle after it stops instead. These are the reducer's rules for that.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INITIAL_VOICE_SESSION, reduceVoiceSession } from '../core/voice/voice-session.mjs';
import { OPENING_CLAUSE_MIN_CHARS, openingClauseLength } from '../core/voice/sentences.mjs';

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

const SETTLE_MS = 250;
const listening = () => run([{ type: 'ready', utteranceHoldMs: SETTLE_MS, continuationMs: 5_000 }]).state;
const holds = (effects) => effects.filter((effect) => effect.kind === 'hold.start').map((effect) => effect.ms);

test('a final heard while the person is still talking does not start the clock', () => {
  const out = run([
    { type: 'hearing', active: true },
    { type: 'final', text: 'First sentence.' },
  ], listening());

  assert.equal(out.state.phase, 'listening');
  assert.equal(out.state.pendingText, 'First sentence.');
  // A hold of 0 stops any running timer: nothing will fire until the engine
  // says the person has stopped.
  assert.deepEqual(holds(out.effects), [0]);
  assert.equal(out.effects.some((effect) => effect.kind === 'turn.run'), false);
});

test('the gathered utterance is sent a settle after the person stops', () => {
  const gathered = run([
    { type: 'hearing', active: true },
    { type: 'final', text: 'First sentence.' },
    { type: 'final', text: 'Second sentence.' },
  ], listening());
  assert.equal(gathered.effects.some((effect) => effect.kind === 'turn.run'), false);

  const stopped = run([{ type: 'hearing', active: false }], gathered.state);
  assert.deepEqual(holds(stopped.effects), [SETTLE_MS]);

  const sent = run([{ type: 'holdElapsed', nowMs: 1_000 }], stopped.state);
  assert.equal(sent.state.phase, 'thinking');
  const turn = sent.effects.find((effect) => effect.kind === 'turn.run');
  assert.equal(turn.text, 'First sentence. Second sentence.');
});

test('a final with nothing more being heard waits only the settle', () => {
  const out = run([{ type: 'final', text: 'Hello there.' }], listening());
  assert.deepEqual(holds(out.effects), [SETTLE_MS]);
});

test('speech that resumes during the settle stops the clock again', () => {
  const settling = run([{ type: 'final', text: 'Hello there.' }], listening());
  const resumed = run([{ type: 'hearing', active: true }], settling.state);
  assert.deepEqual(holds(resumed.effects), [0]);

  // A timer that fired in the same instant is not a commit.
  const raced = run([{ type: 'holdElapsed', nowMs: 1_000 }], resumed.state);
  assert.equal(raced.state.phase, 'listening');
  assert.equal(raced.effects.some((effect) => effect.kind === 'turn.run'), false);
});

test('a partial does not restart the clock while the engine says more is coming', () => {
  const gathered = run([
    { type: 'hearing', active: true },
    { type: 'final', text: 'Hello there.' },
  ], listening());
  const out = run([{ type: 'partial', text: 'and another' }], gathered.state);
  assert.deepEqual(holds(out.effects), [0]);
});

test('hearing with nothing gathered moves no phase and sends no frame', () => {
  const out = run([{ type: 'hearing', active: true }, { type: 'hearing', active: false }], listening());
  assert.equal(out.state.phase, 'listening');
  assert.deepEqual(out.effects, []);
});

test('mute ends whatever was being heard, so an utterance gathered before it is not held for ever', () => {
  const gathered = run([
    { type: 'hearing', active: true },
    { type: 'final', text: 'Hello there.' },
  ], listening());
  const muted = run([{ type: 'mute' }], gathered.state);
  assert.equal(muted.state.hearing, false);

  const unmuted = run([{ type: 'unmute' }], muted.state);
  assert.deepEqual(holds(unmuted.effects), [SETTLE_MS]);
});

test('an engine that never reports hearing keeps the hold it was given', () => {
  const legacy = run([{ type: 'ready', utteranceHoldMs: 1_800, continuationMs: 5_000 }]).state;
  const out = run([{ type: 'final', text: 'Hello there.' }, { type: 'partial', text: 'more' }], legacy);
  assert.deepEqual(holds(out.effects), [1_800, 1_800]);
});

// ─── A reply's speech ends when the reply does, not when a sentence does ───

test('a finished reply closes its generation; the phase waits for the speech to be heard', () => {
  const thinking = run([{ type: 'final', text: 'Hi.' }, { type: 'holdElapsed', nowMs: 0 }], listening());
  const replying = run([
    { type: 'replyDelta', text: 'One sentence. ' },
    { type: 'replyDelta', text: 'And a second' },
  ], thinking.state);
  assert.equal(replying.state.phase, 'speaking');
  assert.equal(replying.effects.some((effect) => effect.kind === 'speech.close'), false, 'more may still be said');

  const done = run([{ type: 'replyDone' }], replying.state);
  const gen = done.state.gen;
  assert.equal(done.state.phase, 'speaking', 'the words are still being spoken');
  const kinds = done.effects.map((effect) => effect.kind);
  assert.ok(kinds.includes('engine.speak'));
  assert.deepEqual(done.effects.find((effect) => effect.kind === 'speech.close'), { kind: 'speech.close', gen });

  const heard = run([{ type: 'speechDone', gen }], done.state);
  assert.equal(heard.state.phase, 'listening');
});

test('a reply that fails part-way keeps actual Bot speech, not a Gate failure utterance', () => {
  const thinking = run([{ type: 'final', text: 'Hi.' }, { type: 'holdElapsed', nowMs: 0 }], listening());
  const replying = run([{ type: 'replyDelta', text: 'It started well. ' }], thinking.state);
  const gen = replying.state.gen;

  const failed = run([{ type: 'replyFailed', message: 'OpenCode stopped before it answered.' }], replying.state);
  assert.equal(failed.state.gen, gen, 'no new generation cuts the sentence in half');
  assert.equal(failed.effects.some((effect) => effect.kind === 'engine.cancelSpeech'), false);
  const spoken = failed.effects.find((effect) => effect.kind === 'engine.speak');
  assert.ok(!spoken || spoken.text === 'It started well. ');
  assert.deepEqual(failed.effects.at(-1), { kind: 'speech.close', gen });
  const frame = failed.effects.find((effect) => effect.kind === 'send' && effect.frame.t === 'turn').frame;
  assert.equal(frame.state, 'failed');
  assert.equal(frame.error, 'OpenCode stopped before it answered.');
});

// ─── The opening clause: the one place a sentence is not waited for ────────

test('the first clause of a reply is spoken before its sentence ends', () => {
  const thinking = run([{ type: 'final', text: 'Hi.' }, { type: 'holdElapsed', nowMs: 0 }], listening());
  const out = run([{ type: 'replyDelta', text: 'Yes, the call is working, and the rest of this sentence is still' }], thinking.state);
  const spoken = out.effects.filter((effect) => effect.kind === 'engine.speak').map((effect) => effect.text);
  assert.deepEqual(spoken, ['Yes, the call is working, ']);

  // Only the opening: once something has been said, sentences are waited for.
  const more = run([{ type: 'replyDelta', text: ' arriving, slowly, in pieces' }], out.state);
  assert.equal(more.effects.some((effect) => effect.kind === 'engine.speak'), false);

  const ended = run([{ type: 'replyDelta', text: '. Next.' }], more.state);
  const rest = ended.effects.filter((effect) => effect.kind === 'engine.speak').map((effect) => effect.text);
  assert.deepEqual(rest, ['and the rest of this sentence is still arriving, slowly, in pieces. Next.']);
});

test('an opening clause is found only where it is safe to cut', () => {
  assert.equal(openingClauseLength('Sure, '), 0, 'too short to be worth a synthesis pass');
  assert.ok('Sure'.length < OPENING_CLAUSE_MIN_CHARS);
  assert.equal(openingClauseLength('It costs 1,000 dollars in total'), 0, 'a comma inside a number is not a clause');
  assert.equal(openingClauseLength('The meeting is at 10:30 tomorrow'), 0, 'nor a colon inside a time');
  assert.equal(openingClauseLength('That works for me,'), 0, 'the mark must be followed by whitespace');
  assert.equal(openingClauseLength('That works for me, and'), 'That works for me, '.length);
  assert.equal(openingClauseLength('Here is the code: then'), 'Here is the code: '.length);
  assert.equal(openingClauseLength('```js\nconst a = 1, b = 2;\n```'), 0, 'never inside a fenced block');
  assert.equal(openingClauseLength(`${'word '.repeat(40)}, tail`), 0, 'a late clause is no faster than its sentence');
});

// ─── Talking again while the turn is still being thought about ─────────────
// The turn is not cancelled the moment a sound is heard: what it says is held
// until it is known whether the sound was words. Words take the turn back and
// both halves go as one; a cough leaves the turn exactly as it was.

const committed = () => run([
  { type: 'final', text: 'So I was thinking about the release plan.' },
  { type: 'holdElapsed', nowMs: 1_000 },
], listening());

const resumed = () => run([
  { type: 'hearing', active: true },
  { type: 'userSpeaking', nowMs: 1_400 },
], committed().state);

test('a reply that starts while the person is talking again is held, not spoken over them', () => {
  const talking = resumed();
  assert.equal(talking.state.phase, 'thinking');
  assert.equal(talking.effects.some((effect) => effect.kind === 'turn.cancel'), false, 'the turn is left running');

  const held = run([
    { type: 'replyDelta', text: 'Sure. ' },
    { type: 'toolUpdate', toolId: 't1', name: 'read', status: 'running', summary: 'read running' },
  ], talking.state);
  assert.equal(held.state.phase, 'thinking');
  assert.deepEqual(held.effects, [], 'nothing is spoken, shown or sent while they talk');
});

test('words that follow take the turn back and both halves go as one', () => {
  const held = run([{ type: 'replyDelta', text: 'Sure. ' }], resumed().state);

  // The sentence took longer to say than the continuation window: it is still
  // the same thought, judged when the speech began.
  const merged = run([{ type: 'final', text: 'and I want to move the date to Friday.', nowMs: 9_000 }], held.state);
  assert.equal(merged.state.phase, 'listening');
  assert.ok(merged.effects.some((effect) => effect.kind === 'turn.cancel'), 'now the half-answered turn is withdrawn');
  assert.equal(merged.effects.some((effect) => effect.kind === 'engine.speak'), false, 'and what it had said is never spoken');
  assert.deepEqual(merged.state.deferred, []);

  const sent = run([
    { type: 'hearing', active: false },
    { type: 'holdElapsed', nowMs: 9_300 },
  ], merged.state);
  const turns = sent.effects.filter((effect) => effect.kind === 'turn.run');
  assert.deepEqual(turns.map((turn) => turn.text), [
    'So I was thinking about the release plan. and I want to move the date to Friday.',
  ]);
});

test('a cough leaves the turn alone, and what it said while held is released in order', () => {
  const held = run([
    { type: 'replyDelta', text: 'Sure, here it is. ' },
    { type: 'replyDelta', text: 'And more.' },
    { type: 'replyDone' },
  ], resumed().state);
  assert.deepEqual(held.effects, []);

  // No final came of the sound: the engine simply stops hearing.
  const released = run([{ type: 'hearing', active: false }], held.state);
  assert.equal(released.effects.some((effect) => effect.kind === 'turn.cancel'), false, 'the prompt is never sent twice');
  assert.equal(released.state.phase, 'speaking');
  assert.equal(released.state.deferring, false);
  const spoken = released.effects.filter((effect) => effect.kind === 'engine.speak').map((effect) => effect.text);
  assert.deepEqual(spoken, ['Sure, here it is. ', 'And more.']);
  const replies = released.effects.filter((effect) => effect.kind === 'send' && effect.frame.t === 'reply');
  assert.deepEqual(replies.map((effect) => effect.frame.delta), ['Sure, here it is. ', 'And more.']);
  assert.ok(released.effects.some((effect) => effect.kind === 'speech.close'));
});

test('once the reply has begun, talking again is not a continuation', () => {
  const replying = run([{ type: 'replyDelta', text: 'Sure. ' }], committed().state);
  const out = run([{ type: 'userSpeaking', nowMs: 1_400 }], replying.state);
  assert.equal(out.state.phase, 'speaking');
  assert.equal(out.state.deferring, false);
  assert.deepEqual(out.effects, [], 'that is a barge-in, and the engine reports those itself');
});

test('talking long after the turn was sent does not hold its reply', () => {
  const out = run([{ type: 'userSpeaking', nowMs: 1_000 + 5_000 }], committed().state);
  assert.equal(out.state.deferring, false);
  const replying = run([{ type: 'replyDelta', text: 'Sure. ' }], out.state);
  assert.equal(replying.state.phase, 'speaking');
});

test('skip while a reply is held drops what was held with the turn', () => {
  const held = run([{ type: 'replyDelta', text: 'Sure. ' }], resumed().state);
  const skipped = run([{ type: 'skip' }], held.state);
  assert.equal(skipped.state.phase, 'listening');
  assert.equal(skipped.state.deferring, false);
  assert.deepEqual(skipped.state.deferred, []);
});

test('speech while merely listening changes nothing', () => {
  const out = run([{ type: 'userSpeaking', nowMs: 10 }], listening());
  assert.equal(out.state.phase, 'listening');
  assert.deepEqual(out.effects, []);
});

test('a turn that finished answering while they talked is not sent a second time', () => {
  const held = run([
    { type: 'replyDelta', text: 'Good idea. ' },
    { type: 'replyDone' },
  ], resumed().state);

  const more = run([{ type: 'final', text: 'and I want to move the date to Friday.', nowMs: 4_000 }], held.state);
  assert.equal(more.state.phase, 'listening');
  // The answer to the first half is in the thread already: the phone is told
  // the turn is done, nothing of it is spoken, and the Bot is not cancelled or
  // asked the first half again.
  assert.equal(more.effects.some((effect) => effect.kind === 'engine.speak'), false);
  assert.equal(more.effects.some((effect) => effect.kind === 'turn.cancel'), false);
  const done = more.effects.find((effect) => effect.kind === 'send' && effect.frame.t === 'turn');
  assert.equal(done.frame.state, 'done');

  const sent = run([
    { type: 'hearing', active: false },
    { type: 'holdElapsed', nowMs: 4_300 },
  ], more.state);
  const turns = sent.effects.filter((effect) => effect.kind === 'turn.run');
  assert.deepEqual(turns.map((turn) => turn.text), ['and I want to move the date to Friday.']);
});
