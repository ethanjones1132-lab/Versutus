import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isModelScopedError } from '../core/providers/errors.mjs';

// 404 is the one status a model and a route both answer with. These pin the
// decision the Gate makes from the record alone: which models the provider
// lists, and which model the turn named.

const models = [
  { providerId: 'zen', id: 'llama-3.1-8b', available: true },
  { providerId: 'zen', id: 'gpt-4', available: true },
];

test('anything but a 404 is not model-scoped', () => {
  assert.equal(isModelScopedError({ status: 401 }, { models, modelId: 'gpt-4' }), false);
  assert.equal(isModelScopedError({ status: 500 }, { models }), false);
  assert.equal(isModelScopedError({}, { models }), false);
});

test('a 404 for a model the provider lists is model-scoped', () => {
  assert.equal(
    isModelScopedError({ status: 404, model: 'gpt-4' }, { models }),
    true,
    'the requested model is on the catalog',
  );
  assert.equal(
    isModelScopedError({ statusCode: 404 }, { models, modelId: 'llama-3.1-8b' }),
    true,
    'the caller can name the model instead of the error',
  );
  assert.equal(
    isModelScopedError({ status: 404, message: 'chat failed: 404 — no such model: llama-3.1-8b' }, { models }),
    true,
    'the vendor body names a listed model',
  );
  assert.equal(
    isModelScopedError(
      { status: 404, body: { error: { message: 'model gpt-4 is not available on this account' } } },
      { models },
    ),
    true,
    'a separate body field is read too',
  );
});

test('a 404 that names no listed model is not model-scoped', () => {
  assert.equal(
    isModelScopedError({ status: 404, message: 'chat failed: 404 — <html>404 Not Found</html>' }, { models }),
    false,
    'a bare 404 says nothing about a model',
  );
  assert.equal(
    isModelScopedError({ status: 404, model: 'gpt-4o-mini' }, { models }),
    false,
    'the requested model is not one this provider carries',
  );
  assert.equal(
    isModelScopedError({ status: 404, message: 'model "gpt-4o-mini" not found' }, { models }),
    false,
  );
});

test('a provider with no listed models never reads a 404 as model-scoped', () => {
  assert.equal(isModelScopedError({ status: 404, model: 'gpt-4' }, { models: [] }), false);
  assert.equal(isModelScopedError({ status: 404, model: 'gpt-4' }), false);
});

test('a listed id is matched whole, not as a prefix of another model', () => {
  // `gpt-4` is listed; a vendor saying `gpt-4o-mini` is missing is not that
  // model being refused.
  assert.equal(isModelScopedError({ status: 404, message: 'model gpt-4o-mini not found' }, { models }), false);
  assert.equal(isModelScopedError({ status: 404, message: 'model gpt-4 not found' }, { models }), true);
  assert.equal(isModelScopedError({ status: 404, message: 'model gpt-4-turbo not found' }, { models }), false);
});

test('a catalog entry may be a bare id, and a body that cannot be serialised never throws', () => {
  assert.equal(isModelScopedError({ status: 404, model: 'gpt-4' }, { models: ['gpt-4'] }), true);
  // An entry with no id names nothing, and must not become the string "undefined".
  assert.equal(
    isModelScopedError({ status: 404, message: 'model undefined not found' }, { models: [{ providerId: 'zen' }] }),
    false,
  );
  const circular = {};
  circular.self = circular;
  assert.equal(
    isModelScopedError({ status: 404, body: circular, message: 'chat failed: 404' }, { models }),
    false,
  );
  assert.equal(
    isModelScopedError({ status: 404, response: { body: 'model gpt-4 not found' } }, { models }),
    true,
  );
});

