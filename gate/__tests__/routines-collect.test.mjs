import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collectRoutines, unsupportedRoutineRead } from '../core/routines.mjs';

/** One Hermes job record, in the snake_case shape /api/jobs answers. */
function job(id, name) {
  return { id, name, schedule: '0 3 * * *', enabled: true };
}

test('a hung backend fails on its own timeout without holding the others', async () => {
  const hung = { id: 'hung', label: 'Hung', listJobs: () => new Promise(() => {}) };
  const healthy = { id: 'healthy', label: 'Healthy', listJobs: async () => [job('job-1', 'Nightly digest')] };

  // The race is the test's own guard, not the code under test: on a build that
  // ignored the timeout this would stall here instead of reporting.
  let guard;
  const outcome = await Promise.race([
    collectRoutines({ backends: [hung, healthy], timeoutMs: 25 }),
    new Promise((resolve) => {
      guard = setTimeout(() => resolve('stuck'), 2_000);
    }),
  ]);
  clearTimeout(guard);

  assert.notEqual(outcome, 'stuck', 'collectRoutines waited on a backend that never answers');
  assert.deepEqual(outcome.backends.map((backend) => [backend.id, backend.status]), [
    ['hung', 'failed'],
    ['healthy', 'complete'],
  ]);
  assert.match(outcome.backends[0].error, /timed out/);
  // The healthy host's rows still landed; one dead read did not hide them.
  assert.deepEqual(outcome.routines.map((routine) => routine.id), ['job-1']);
});

test('a backend that discovers it has no listJobs after starting stays unavailable', async () => {
  const late = {
    id: 'late',
    label: 'Late',
    listJobs: async () => {
      throw unsupportedRoutineRead('Late');
    },
  };

  const result = await collectRoutines({ backends: [late] });

  assert.deepEqual(result.backends.map((backend) => [backend.id, backend.status]), [['late', 'unavailable']]);
  // Unsupported carries no reason the app would paint as a failure.
  assert.equal(Object.hasOwn(result.backends[0], 'error'), false);
  assert.deepEqual(result.routines, []);
});

test('a backend with no listJobs is unavailable and never asked for a read', async () => {
  const result = await collectRoutines({ backends: [{ id: 'plain', label: 'Plain' }] });

  assert.deepEqual(result.backends, [{ id: 'plain', label: 'Plain', status: 'unavailable' }]);
  assert.deepEqual(result.routines, []);
});
