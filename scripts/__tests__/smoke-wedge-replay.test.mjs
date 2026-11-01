// Pin for the wedge replay evidence (../smoke-wedge-loop.mjs, through
// ../__tests__/fixtures/wedge-replay-evidence.mjs).
//
// A phone that dropped its SSE connection reattaches and gets the run's whole
// event log replayed. The smoke used to prove that by comparing event TYPES
// only, so a replay that swapped two `run.output` fragments, drifted a
// sequence, named another run or dropped a payload field still read as green —
// the exact corruption an operator sees as mangled text under "completed".
//
// These tests pin the stronger contract: sequence, type, runId and the full
// payload tree must agree. Only the emission timestamp is normalised, because
// it is a wall-clock mark and a run reloaded after its Gate died gets a
// synthesized closing verdict with a fresh stamp.
//
// Lives under scripts/__tests__ because it pins a repo script; it runs through
// the same `npm run test:gate` node --test leg.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compareRunEventStreams } from './fixtures/wedge-replay-evidence.mjs';

/**
 * One event shaped exactly like `createEventLog().emit` in
 * gate/core/cli-environments/run-protocol.mjs: runId, sequence, timestamp,
 * type, payload.
 */
function event(sequence, type, payload, overrides = {}) {
  return {
    runId: 'run-wedge-1',
    sequence,
    timestamp: `2026-11-01T06:00:0${sequence}.000Z`,
    type,
    payload,
    ...overrides,
  };
}

/** The pong run's shape: started → approval card → output → completed. */
function liveStream() {
  return [
    event(1, 'run.started', { operation: 'prompt', sandbox: 'read_only' }),
    event(2, 'approval.required', { approvalId: 'appr-9', reason: 'workspace write' }),
    event(3, 'run.output', { stream: 'stdout', text: 'po' }),
    event(4, 'run.output', { stream: 'stdout', text: 'ng' }),
    event(5, 'run.completed', { exitCode: 0 }),
  ];
}

test('an identical replay agrees and reports how many events were checked', () => {
  const live = liveStream();
  const verdict = compareRunEventStreams(live, structuredClone(live));
  assert.deepEqual(verdict, { ok: true, count: 5 });
});

test('payload differences are caught even when types and sequences all match', () => {
  // The old type-only comparison passed this: same five types, same sequences,
  // same ids — but the streamed reply is out of order on the reattaching phone.
  const live = liveStream();
  const replayed = structuredClone(live);
  replayed[2].payload.text = 'ng';
  replayed[3].payload.text = 'po';

  const verdict = compareRunEventStreams(live, replayed);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /event 3 \(run\.output\)/);
  assert.match(verdict.reason, /payload\.text/);
  assert.match(verdict.reason, /"po"/);
  assert.match(verdict.reason, /"ng"/);
});

test('a sequence gap is caught even when the surviving payloads match', () => {
  const live = liveStream();
  const replayed = structuredClone(live);
  replayed[3].sequence = 9;

  const verdict = compareRunEventStreams(live, replayed);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /event 4 \(run\.output\)/);
  assert.match(verdict.reason, /sequence 9/);
});

test('a replay that names another run is caught', () => {
  const live = liveStream();
  const replayed = structuredClone(live);
  replayed[4].runId = 'run-someone-else';

  const verdict = compareRunEventStreams(live, replayed);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /event 5 \(run\.completed\)/);
  assert.match(verdict.reason, /run-someone-else/);
});

test('a truncated replay is caught by count, not silently accepted', () => {
  const live = liveStream();
  const verdict = compareRunEventStreams(live, live.slice(0, 4));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /4 event\(s\).*5/);
});

test('a dropped payload field is caught by name', () => {
  const live = liveStream();
  const replayed = structuredClone(live);
  delete replayed[2].payload.text;

  const verdict = compareRunEventStreams(live, replayed);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /payload\.text: missing from replay/);
});

test('a payload field the live stream never had is caught too', () => {
  const live = liveStream();
  const replayed = structuredClone(live);
  replayed[1].payload.replayed = true;

  const verdict = compareRunEventStreams(live, replayed);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /payload\.replayed: not in live/);
});

test('nested payload trees are compared field by field', () => {
  const live = [
    event(1, 'run.note', {
      level: 'warning',
      bindings: [
        { variable: 'A', reference: 'provider/a/key' },
        { variable: 'B', reference: 'provider/b/key' },
      ],
    }),
  ];
  const replayed = structuredClone(live);
  replayed[0].payload.bindings[1].variable = 'wrong';

  const verdict = compareRunEventStreams(live, replayed);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /payload\.bindings\[1\]\.variable/);
  assert.match(verdict.reason, /"B"/);
});

test('an array length change is reported at the array path', () => {
  const live = [event(1, 'run.note', { bindings: [{ variable: 'A' }, { variable: 'B' }] })];
  const replayed = structuredClone(live);
  replayed[0].payload.bindings.pop();

  const verdict = compareRunEventStreams(live, replayed);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /payload\.bindings: live has 2 item\(s\), replay has 1/);
});

test('only the emission timestamp may differ between live and replay', () => {
  const live = liveStream();
  const replayed = structuredClone(live).map((entry) => ({
    ...entry,
    timestamp: '2026-11-01T09:30:00.000Z',
  }));

  assert.deepEqual(compareRunEventStreams(live, replayed), { ok: true, count: live.length });
});

test('malformed streams fail loudly instead of throwing or passing', () => {
  const live = liveStream();
  for (const bad of [null, undefined, {}, 'events', 42]) {
    const asLive = compareRunEventStreams(bad, live);
    assert.equal(asLive.ok, false, `live ${JSON.stringify(bad)} must fail`);
    assert.match(asLive.reason, /live stream is not an array/);

    const asReplay = compareRunEventStreams(live, bad);
    assert.equal(asReplay.ok, false, `replay ${JSON.stringify(bad)} must fail`);
    assert.match(asReplay.reason, /replay is not an array/);
  }
});

test('a non-object event member fails with its position', () => {
  const live = liveStream();
  const replayed = structuredClone(live);
  replayed[2] = null;

  const verdict = compareRunEventStreams(live, replayed);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /event 3: the replayed event is not an object/);
});

test('two empty streams agree, and comparison never rewrites either side', () => {
  assert.deepEqual(compareRunEventStreams([], []), { ok: true, count: 0 });

  const live = liveStream();
  const replayed = structuredClone(live);
  const liveSnapshot = structuredClone(live);
  const replayedSnapshot = structuredClone(replayed);

  compareRunEventStreams(live, replayed);
  assert.deepEqual(live, liveSnapshot);
  assert.deepEqual(replayed, replayedSnapshot);
});
