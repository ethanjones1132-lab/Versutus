import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FAILING_AFTER,
  FAILING_TTL_MS,
  createModelHealth,
  modelHealthKey,
  shortReason,
} from '../core/model-health.mjs';

// Nothing in a catalogue says whether a turn completes. On the live host
// (2026-10-01) `opencode-go` listed 42 models and refused every one of them
// (400 MissingSessionID), and the picker kept offering them, because no
// catalogue anywhere kept score. This table is that score — written only by real
// turns, so it costs no quota and never reads Hermes's state.db.

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })));
});

async function stateFile(name = 'model-health.json') {
  const root = await mkdtemp(join(tmpdir(), 'gate-modelhealth-'));
  roots.push(root);
  return join(root, name);
}

/** A clock the test moves, so six hours pass without six hours passing. */
function fakeClock(start = Date.parse('2026-10-01T12:00:00.000Z')) {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; } };
}

const KEY = 'hermes-local|opencode-go/omen-alpha';

test('the key a verdict is filed under is the one the catalogue files the model as', () => {
  assert.equal(modelHealthKey('hermes-local', 'opencode-go/omen-alpha'), KEY);
  // A Gate provider's rows carry no backendId, so they are judged as `gate`.
  assert.equal(modelHealthKey(undefined, 'gpt-5.6-sol'), 'gate|gpt-5.6-sol');
  // A turn that named no model has nothing to be a verdict about.
  assert.equal(modelHealthKey('hermes-local', undefined), '');
  assert.equal(modelHealthKey('hermes-local', '  '), '');
});

test('two consecutive failures fail the model; one does not', () => {
  const health = createModelHealth();
  assert.equal(FAILING_AFTER, 2);

  health.recordFailure(KEY, 'HTTP 400: MissingSessionID');
  assert.equal(health.verdict(KEY), null, 'one refused turn is an accident');

  health.recordFailure(KEY, 'HTTP 400: MissingSessionID');
  const verdict = health.verdict(KEY);
  assert.equal(verdict.failing, true);
  assert.equal(verdict.reason, 'HTTP 400: MissingSessionID');
  assert.equal(verdict.until - verdict.since, FAILING_TTL_MS);
});

test('a turn that answered clears the model at once', () => {
  const health = createModelHealth();
  health.recordFailure(KEY, 'HTTP 400: MissingSessionID');
  health.recordFailure(KEY, 'HTTP 400: MissingSessionID');
  assert.equal(health.verdict(KEY).failing, true);

  // The operator fixed the key (or the provider came back): the model clearly
  // CAN answer here, so it is offered again without anything else being read.
  health.recordSuccess(KEY);
  assert.equal(health.verdict(KEY), null);
  assert.equal(health.size(), 0);
});

test('the hiding window is six hours, then the model is offered again', () => {
  const clock = fakeClock();
  const health = createModelHealth({ now: clock.now });
  health.recordFailure(KEY, 'HTTP 400: MissingSessionID');
  health.recordFailure(KEY, 'HTTP 400: MissingSessionID');

  clock.advance(FAILING_TTL_MS - 1);
  assert.equal(health.verdict(KEY).failing, true, 'still hidden one ms before the window ends');

  clock.advance(1);
  assert.equal(health.verdict(KEY), null, 'offered again once the window is over');
  // And the expired verdict is forgotten rather than carried to disk: a turn
  // that fails now has to earn the verdict again from scratch.
  assert.equal(health.size(), 0);
  health.recordFailure(KEY, 'HTTP 400: MissingSessionID');
  assert.equal(health.verdict(KEY), null);
});

test('a failure after the window is a new failure, not an old one counted twice', () => {
  const clock = fakeClock();
  const health = createModelHealth({ now: clock.now });
  health.recordFailure(KEY, 'first');
  clock.advance(FAILING_TTL_MS);
  health.recordFailure(KEY, 'second');

  assert.equal(health.verdict(KEY), null, 'the verdict from before the window is gone');
  health.recordFailure(KEY, 'second');
  assert.equal(health.verdict(KEY).reason, 'second');
});

test('the table survives a restart', async () => {
  const file = await stateFile();
  const clock = fakeClock();
  const first = createModelHealth({ file, now: clock.now, writeDelayMs: 1 });
  first.recordFailure(KEY, 'HTTP 400: MissingSessionID');
  first.recordFailure(KEY, 'HTTP 400: MissingSessionID');

  await waitFor(async () => (await readFile(file, 'utf8')).includes(KEY));
  const second = createModelHealth({ file, now: clock.now });
  assert.equal(second.verdict(KEY).failing, true);
  assert.equal(second.verdict(KEY).reason, 'HTTP 400: MissingSessionID');

  // A clear is persisted as well: a restart must not resurrect a verdict the
  // model has already answered.
  second.recordSuccess(KEY);
  await waitFor(async () => !(await readFile(file, 'utf8')).includes(KEY));
  assert.equal(createModelHealth({ file, now: clock.now }).verdict(KEY), null);
});

test('a verdict written six hours ago is not loaded back as failing', async () => {
  const file = await stateFile();
  const clock = fakeClock();
  const before = createModelHealth({ file, now: clock.now, writeDelayMs: 1 });
  before.recordFailure(KEY, 'HTTP 400: MissingSessionID');
  before.recordFailure(KEY, 'HTTP 400: MissingSessionID');
  await waitFor(async () => (await readFile(file, 'utf8')).includes(KEY));

  clock.advance(FAILING_TTL_MS + 1);
  assert.equal(createModelHealth({ file, now: clock.now }).verdict(KEY), null);
});

test('a corrupt or unreadable file is an empty table, never a failed request', async () => {
  const file = await stateFile();
  await writeFile(file, '{ this is not json', 'utf8');

  const health = createModelHealth({ file });
  assert.equal(health.verdict(KEY), null);
  // And the table is usable: a fresh verdict is written over the bad file.
  health.recordFailure(KEY, 'HTTP 400: MissingSessionID');
  health.recordFailure(KEY, 'HTTP 400: MissingSessionID');
  assert.equal(health.verdict(KEY).failing, true);
  await waitFor(async () => JSON.parse(await readFile(file, 'utf8')).models?.[KEY]);
});

test('no key, no verdict, no file', async () => {
  const file = await stateFile();
  const health = createModelHealth({ file });
  health.recordFailure('', 'nothing to judge');
  health.recordSuccess(undefined);
  assert.equal(health.verdict(''), null);
  assert.equal(health.verdict(undefined), null);
  assert.equal(health.size(), 0);
  // Nothing was written, so nothing had to be created.
  await assert.rejects(() => readFile(file, 'utf8'));
});

test('a verdict written against the Gate\'s own fault heals itself on the next load', async () => {
  // What the 2026-10-02 defect left behind: `call()` read OpenCode's empty 204
  // with `response.json()`, so two turns failed with `Unexpected end of JSON
  // input` and the operator's models were hidden for six hours — a verdict about
  // the Gate's code, held against the model. Nobody should have to edit the file
  // to undo it: a stored reason that is one of the Gate's own signatures is not
  // evidence about a model, so it is dropped on load and written back out.
  const file = await stateFile();
  const clock = fakeClock();
  const at = clock.now();
  await writeFile(file, JSON.stringify({
    models: {
      'opencode-local|opencode/fledge-alpha-free': {
        failures: 2, reason: 'Unexpected end of JSON input', since: at,
      },
      'hermes-local|opencode-go/longcat-2.5-preview-free': {
        failures: 2, reason: 'HTTP 404: No endpoints available for openrouter/free', since: at,
      },
    },
  }), 'utf8');

  const health = createModelHealth({ file, now: clock.now, writeDelayMs: 1 });
  assert.equal(health.verdict('opencode-local|opencode/fledge-alpha-free'), null);
  assert.equal(health.size(), 1);
  const kept = health.verdict('hermes-local|opencode-go/longcat-2.5-preview-free');
  assert.equal(kept.failing, true, 'a real provider failure is still held against its model');
  assert.match(kept.reason, /No endpoints available/);

  // ...and the wrong verdict is gone from disk, not only from memory.
  await waitFor(async () => !(await readFile(file, 'utf8')).includes('Unexpected end of JSON input'));
  const written = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(written.models), ['hermes-local|opencode-go/longcat-2.5-preview-free']);
});

test('the reason the picker shows is one line and short', () => {
  assert.equal(shortReason('HTTP 400: MissingSessionID'), 'HTTP 400: MissingSessionID');
  assert.equal(shortReason('  HTTP 400:\n  two lines  '), 'HTTP 400: two lines');
  assert.equal(shortReason('x'.repeat(400)).length, 120);
  assert.match(shortReason('x'.repeat(400)), /…$/);
  assert.equal(shortReason(undefined), '');
});

test('a refused turn is written down in one file write, not one per failure', async () => {
  const file = await stateFile();
  const health = createModelHealth({ file, writeDelayMs: 5 });
  for (let attempt = 0; attempt < 5; attempt += 1) health.recordFailure(KEY, `refusal ${attempt}`);

  await waitFor(async () => JSON.parse(await readFile(file, 'utf8')).models?.[KEY]?.failures === 5);
  assert.equal(health.verdict(KEY).failures, 5);
});

/** Wait until `read` is true, or give up. Coalesced writes land on a timer. */
async function waitFor(read, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await read()) return;
    } catch {
      // Not written yet.
    }
    if (Date.now() > deadline) throw new Error('timed out waiting for the health file');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}