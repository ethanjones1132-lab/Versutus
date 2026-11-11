import { test } from 'node:test';
import assert from 'node:assert/strict';

import { completeSentenceLength, speechChunks } from '../core/voice/sentences.mjs';
import { INITIAL_VOICE_SESSION, reduceVoiceSession } from '../core/voice/voice-session.mjs';

const FENCE = '```js\nconst a = 1. Then b.\n```\n';

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

test('a fenced block is spoken as one chunk even past a small length budget', () => {
  const reply = `Here:\n${FENCE}Done.`;

  assert.deepEqual(speechChunks(reply, 10), ['Here:\n', FENCE, 'Done.']);
});

test('sentence punctuation inside a fence is not a cut point', () => {
  const block = '```\nOne. Two!\n```\n';

  assert.deepEqual(speechChunks(block, 5), [block]);
});

test('an indented fence is kept whole too, since the worker still cleans it', () => {
  const reply = '    ```js\n    const a = 1.\n    ```\nAfter.';

  assert.deepEqual(speechChunks(reply, 10), [
    '    ```js\n    const a = 1.\n    ```\n',
    'After.',
  ]);
});

test('a fence still open mid-stream is not spoken until it closes', () => {
  const open = 'Here.\n```js\nconst a = 1.';

  // Only the prose before the fence is complete, so only that may be spoken.
  assert.equal(completeSentenceLength(open), 'Here.\n'.length);
  assert.deepEqual(speechChunks(open, 10), ['Here.\n', '```js\nconst a = 1.']);
});

test('a fence that closes mid-stream becomes speakable as one whole chunk', () => {
  const closed = 'Here.\n```js\nconst a = 1.\n```\nDone.';

  assert.equal(completeSentenceLength(closed), closed.length);
  assert.deepEqual(speechChunks(closed, 10), [
    'Here.\n',
    '```js\nconst a = 1.\n```\n',
    'Done.',
  ]);
});

test('an unclosed fence at the end is handed over whole, so the worker can replace it', () => {
  const { effects } = run([
    { type: 'ready' },
    { type: 'final', text: 'Hello there.' },
    { type: 'replyDelta', text: 'Try:\n```js\nprint(x)' },
    { type: 'replyDone' },
  ]);
  const spoken = effects.filter((e) => e.kind === 'engine.speak').map((e) => e.text);

  assert.deepEqual(spoken, ['Try:\n', '```js\nprint(x)']);
});

test('a streamed fence never reaches the engine in pieces, and the thread text stays raw', () => {
  const deltas = ['Here:\n```js\n', 'const a = 1.\n', '```\nDone.'];
  const { effects } = run([
    { type: 'ready' },
    { type: 'final', text: 'Hello there.' },
    ...deltas.map((text) => ({ type: 'replyDelta', text })),
  ]);
  const spoken = effects.filter((e) => e.kind === 'engine.speak').map((e) => e.text);
  const replyFrames = effects
    .filter((e) => e.kind === 'send' && e.frame.t === 'reply')
    .map((e) => e.frame.delta)
    .join('');

  // The whole fence, never a line of its body on its own.
  assert.deepEqual(spoken, ['Here:\n', '```js\nconst a = 1.\n```\nDone.']);
  // What the thread shows is the reply as the backend wrote it.
  assert.equal(replyFrames, deltas.join(''));
});

test('prose after a fence splits again as usual', () => {
  assert.deepEqual(speechChunks('```\nx\n```\nOne. Two.', 5), [
    '```\nx\n```\n',
    'One. ',
    'Two.',
  ]);
});

test('plain prose still splits where it always did', () => {
  assert.deepEqual(speechChunks('One. Two! Three?', 100), ['One. Two! Three?']);
  assert.deepEqual(speechChunks('One. Two.', 5), ['One. ', 'Two.']);
  assert.deepEqual(speechChunks('', 100), []);
});

test('chunks are slices of the reply, so joining them gives it back unchanged', () => {
  const reply = `Intro.\n${FENCE}Outro, with a list:\n- one\n- two`;

  assert.equal(speechChunks(reply, 12).join(''), reply);
});
