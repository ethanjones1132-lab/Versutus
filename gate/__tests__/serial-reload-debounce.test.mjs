import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDebouncedReload } from '../core/serial-reload.mjs';

// The doc on `createDebouncedReload` promises a run "a moment after the last"
// request of a burst. The timer used to be fixed by the first request, so a
// phone retrying for longer than the delay had its reload fired from the first
// attempt's deadline — before the last request it was meant to answer.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a request during the wait moves the run to a moment after the last one', async () => {
  let reloads = 0;
  const delayMs = 200;
  const schedule = createDebouncedReload(async () => { reloads += 1; }, { delayMs });

  schedule();
  // Halfway through the window the first request opened, another arrives.
  await sleep(delayMs / 2);
  schedule();

  // Past the first request's deadline (the old timer stood at 200ms) but inside
  // the window the second request opened (which closes at 300ms), the run must
  // still be waiting.
  await sleep(delayMs * 0.75);
  assert.equal(
    reloads,
    0,
    'the run fired from the first request, before the last request had its moment',
  );

  // Once the window the second request opened closes, it runs — exactly once.
  await sleep(delayMs);
  assert.equal(reloads, 1, 'a burst of requests still costs exactly one reload');
});

test('a request after the run has fired schedules a fresh one', async () => {
  let reloads = 0;
  const delayMs = 20;
  const schedule = createDebouncedReload(async () => { reloads += 1; }, { delayMs });

  schedule();
  await sleep(delayMs * 4);
  assert.equal(reloads, 1);

  schedule();
  await sleep(delayMs * 4);
  assert.equal(reloads, 2, 'restarting the timer must not leave the handle set forever');
});
