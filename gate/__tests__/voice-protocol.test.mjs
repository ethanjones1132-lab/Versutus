import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  MAX_FRAME_BYTES,
  VoiceProtocolError,
  parseGateFrame,
  parsePhoneFrame,
  serializeFrame,
} from '../core/voice/protocol.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'voice-protocol.json'), 'utf8'));

function acceptedByEither(frame) {
  for (const parse of [parsePhoneFrame, parseGateFrame]) {
    try {
      parse(JSON.stringify(frame));
      return true;
    } catch {
      // try the other side
    }
  }
  return false;
}

test('every phone frame in the shared fixture parses', () => {
  for (const frame of fixture.phoneToGate) {
    assert.deepEqual(parsePhoneFrame(JSON.stringify(frame)), frame);
  }
});

test('every Gate frame in the shared fixture parses', () => {
  for (const frame of fixture.gateToPhone) {
    assert.deepEqual(parseGateFrame(JSON.stringify(frame)), frame);
  }
});

test('every malformed frame in the shared fixture is rejected', () => {
  for (const frame of fixture.malformed) {
    assert.equal(acceptedByEither(frame), false, JSON.stringify(frame));
  }
});

test('a frame over the size cap is refused', () => {
  const huge = JSON.stringify({ t: 'partial', text: 'x'.repeat(MAX_FRAME_BYTES + 1) });
  assert.throws(() => parseGateFrame(huge), VoiceProtocolError);
});

test('serializeFrame round-trips through the Gate parser', () => {
  for (const frame of fixture.gateToPhone) {
    assert.deepEqual(parseGateFrame(serializeFrame(frame)), frame);
  }
});
