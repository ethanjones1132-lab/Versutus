import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCRIPTED_FRAME_BYTES,
  ScriptedEngine,
  scriptedEngineEnabled,
} from '../core/voice/engines/scripted-engine.mjs';

test('a scripted engine turns pushed audio into a fixture final', () => {
  const engine = new ScriptedEngine({ text: 'hello', framesBeforeFinal: 2 });
  const finals = [];
  engine.on('final', (event) => finals.push(event.text));
  engine.pushAudio(Buffer.alloc(640));
  assert.deepEqual(finals, []);
  engine.pushAudio(Buffer.alloc(640));
  assert.deepEqual(finals, ['hello']);
});

test('speak answers silence PCM of the right duration and generation', () => {
  const engine = new ScriptedEngine({ minSpeechMs: 200 });
  const frames = [];
  let done = null;
  engine.on('speechAudio', (event) => frames.push(event));
  engine.on('speechDone', (event) => {
    done = event;
  });
  engine.speak('hello there', { gen: 3, final: true });
  assert.ok(frames.length >= 1);
  const totalBytes = frames.reduce((sum, frame) => sum + frame.pcm.length, 0);
  assert.equal(totalBytes % SCRIPTED_FRAME_BYTES, 0);
  assert.equal(frames.every((frame) => frame.gen === 3), true);
  assert.equal(done.gen, 3);
});

test('a cancelled generation speaks nothing', () => {
  const engine = new ScriptedEngine();
  const frames = [];
  engine.on('speechAudio', (event) => frames.push(event));
  engine.cancelSpeech(9);
  engine.speak('nope', { gen: 9 });
  assert.equal(frames.length, 0);
});

test('a muted engine stays silent', () => {
  const engine = new ScriptedEngine();
  const frames = [];
  engine.on('speechAudio', (event) => frames.push(event));
  engine.setMuted(true);
  engine.speak('quiet', { gen: 1 });
  assert.equal(frames.length, 0);
});

test('VERSUTUS_VOICE_SCRIPTED=1 selects the scripted engine', () => {
  assert.equal(scriptedEngineEnabled({ VERSUTUS_VOICE_SCRIPTED: '1' }), true);
  assert.equal(scriptedEngineEnabled({}), false);
});
