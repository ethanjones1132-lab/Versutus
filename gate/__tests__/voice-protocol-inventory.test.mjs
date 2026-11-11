import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  GATE_FRAME_TYPES,
  PHONE_FRAME_TYPES,
  parseGateFrame,
  parsePhoneFrame,
} from '../core/voice/protocol.mjs';

// The fixture is the declared event inventory. A type that no frame in it can
// exercise is a type neither side really implements, so the two sets must match
// exactly: no dead declaration and no undeclared frame.
const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'voice-protocol.json'), 'utf8'));

function typesOf(frames) {
  return [...new Set(frames.map((frame) => frame.t))].sort();
}

test('every declared phone type is in the fixture and parses', () => {
  const v1 = fixture.phoneToGate;
  const v2 = fixture.v2PhoneToGate;
  assert.deepEqual(typesOf([...v1, ...v2]), [...PHONE_FRAME_TYPES].sort());
  for (const frame of v1) assert.deepEqual(parsePhoneFrame(JSON.stringify(frame)), frame);
  for (const frame of v2) assert.deepEqual(parsePhoneFrame(frame, { callId: 'vs-1' }), frame);
});

test('every declared Gate type is in the fixture and parses', () => {
  const v1 = fixture.gateToPhone;
  const v2 = fixture.v2GateToPhone;
  assert.deepEqual(typesOf([...v1, ...v2]), [...GATE_FRAME_TYPES].sort());
  for (const frame of v1) {
    assert.equal(frame.v, undefined, `${frame.t} is a v1 frame`);
    assert.deepEqual(parseGateFrame(JSON.stringify(frame)), frame);
  }
  for (const frame of v2) {
    assert.equal(frame.v, 2, `${frame.t} carries the v2 envelope`);
    assert.deepEqual(parseGateFrame(frame, { callId: 'vs-1' }), frame);
  }
});

test('the fixture contains no frame outside the declarations', () => {
  const phone = new Set(PHONE_FRAME_TYPES);
  const gate = new Set(GATE_FRAME_TYPES);
  for (const frame of [...fixture.phoneToGate, ...fixture.v2PhoneToGate]) {
    assert.ok(phone.has(frame.t), `${frame.t} is declared for the phone`);
  }
  for (const frame of [...fixture.gateToPhone, ...fixture.v2GateToPhone]) {
    assert.ok(gate.has(frame.t), `${frame.t} is declared for the Gate`);
  }
});
