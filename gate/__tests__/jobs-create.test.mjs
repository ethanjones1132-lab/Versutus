import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGatewayMethods } from '../core/capabilities/gateway-methods.mjs';

function methodsWith(createJob) {
  return createGatewayMethods({
    getBackend: async () => ({ createJob }),
  });
}

test('jobs.create files through the backend createJob with the trimmed body', async () => {
  const seen = [];
  const methods = methodsWith(async (body) => {
    seen.push(body);
    return { id: 'job-1', name: body.name };
  });

  const result = await methods['jobs.create']({
    name: '  Nightly check ',
    schedule: '0 9 * * *',
    prompt: ' check the gate health ',
  });
  assert.deepEqual(result, { id: 'job-1', name: 'Nightly check' });
  assert.deepEqual(seen, [
    { name: 'Nightly check', schedule: '0 9 * * *', prompt: 'check the gate health' },
  ]);
});

test('jobs.create requires a name, a prompt, and a schedule', async () => {
  const methods = methodsWith(async () => ({ id: 'job-1' }));

  await assert.rejects(methods['jobs.create']({ schedule: 'daily', prompt: 'x' }), /name is required/);
  await assert.rejects(
    methods['jobs.create']({ name: 'Nightly', schedule: 'daily' }),
    /prompt is required/,
  );
  await assert.rejects(
    methods['jobs.create']({ name: 'Nightly', prompt: 'x' }),
    /schedule is required/,
  );
  await assert.rejects(
    methods['jobs.create']({ name: '   ', schedule: 'daily', prompt: 'x' }),
    /name is required/,
  );
});

test('jobs.create without a job backend fails honestly', async () => {
  const methods = createGatewayMethods({ getBackend: async () => ({}) });

  await assert.rejects(
    methods['jobs.create']({ name: 'Nightly', schedule: 'daily', prompt: 'x' }),
    /does not implement createJob/,
  );
});
