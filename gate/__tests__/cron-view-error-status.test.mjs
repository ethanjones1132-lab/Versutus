import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toCronRunView } from '../core/cron-view.mjs';

// An end time alone says a run stopped, not that it succeeded. Hermes writes
// `end_reason: 'error'` for a failed run, and a view that calls it "completed"
// hands history, widgets and the phone a false success.

test('a finished run that ended in error is failed, not completed', () => {
  const run = toCronRunView({
    id: 'cron_aaa_20260824_180021',
    started_at: 100,
    ended_at: 200,
    end_reason: 'error',
  });
  assert.equal(run.status, 'failed');
  // The failure must stay visible even when the host wrote no detail.
  assert.ok(run.error, 'a failed run carries a non-empty marker');
});

test('a finished run with no error reason stays completed', () => {
  const run = toCronRunView({
    id: 'cron_aaa_20260824_180021',
    started_at: 100,
    ended_at: 200,
  });
  assert.equal(run.status, 'completed');
  assert.equal(run.error, null);
});

test('a run that has not ended is still running', () => {
  const run = toCronRunView({
    id: 'cron_aaa_20260824_180021',
    started_at: 100,
    ended_at: null,
  });
  assert.equal(run.status, 'running');
});
