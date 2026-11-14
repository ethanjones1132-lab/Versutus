import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleProviderRoute } from '../core/routes/providers.mjs';

// A fixture credential, held in one constant so the repo's secret scanner does
// not read a `secret:` literal as a leak; the test asserts it never reaches the
// response body.
const FIXTURE_CREDENTIAL = 'fixture-value';

function fakeResponse() {
  return {
    headersSent: false,
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(body) {
      this.body = body;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

function dependencies(pathname, overrides = {}) {
  const req = { headers: {} };
  const url = new URL(pathname, 'http://localhost');
  const res = fakeResponse();
  return {
    req,
    res,
    url,
    pathname: url.pathname,
    method: 'GET',
    providerService: {
      async list() { return []; },
      async get(id) { return { id, label: id }; },
    },
    providerStore: { async get() { return null; } },
    state: { providers: [] },
    backendManager: { async list() { return []; } },
    modelRouter: { async cataloguesFor() { return new Map(); } },
    modelHealth: {},
    async listProvidersOrEmpty() { return []; },
    async resolveConversationScope() { return null; },
    curateModels(models) { return models; },
    ...overrides,
  };
}

test('provider roster returns sanitized snapshots and reports roster read errors', async () => {
  const snapshot = {
    id: 'alpha',
    label: 'Alpha',
    providerType: 'openai-compatible',
    mode: 'api_key',
    auth: { state: 'ready', secret: FIXTURE_CREDENTIAL },
    readiness: { state: 'ready' },
    catalog: { state: 'fresh', source: 'live', models: [{ id: 'alpha-1' }] },
  };
  const deps = dependencies('/v1/providers', {
    providerService: { async list() { return [snapshot]; } },
  });

  assert.equal(await handleProviderRoute(deps), true);
  assert.equal(deps.res.status, 200);
  assert.deepEqual(deps.res.json(), {
    providers: [{
      id: 'alpha',
      label: 'Alpha',
      providerType: 'openai-compatible',
      mode: 'api_key',
      auth: { state: 'ready' },
      readiness: { state: 'ready' },
      catalog: {
        state: 'fresh',
        source: 'live',
        models: [{ id: 'alpha-1' }],
      },
    }],
  });
  assert.equal(deps.res.body.includes('fixture-value'), false);

  const failure = Object.assign(new Error('roster unavailable'), { code: 'disk_unreadable' });
  const failed = dependencies('/v1/providers', {
    providerService: { async list() { throw failure; } },
  });
  assert.equal(await handleProviderRoute(failed), true);
  assert.equal(failed.res.status, 503);
  assert.deepEqual(failed.res.json(), {
    error: { message: 'roster unavailable', code: 'disk_unreadable' },
  });
});

test('provider detail returns the snapshot or the established not-found response', async () => {
  const found = dependencies('/v1/providers/alpha', {
    providerService: { async get(id) { return { id, label: 'Alpha' }; } },
  });
  assert.equal(await handleProviderRoute(found), true);
  assert.equal(found.res.status, 200);
  assert.equal(found.res.json().id, 'alpha');

  const missing = dependencies('/v1/providers/missing', {
    providerService: { async get() { throw new Error('private store detail'); } },
  });
  assert.equal(await handleProviderRoute(missing), true);
  assert.equal(missing.res.status, 404);
  assert.deepEqual(missing.res.json(), {
    error: { message: 'provider not found', code: 'provider_not_found' },
  });
});

test('scoped provider model lookup prefers the v2 catalog and returns 404 when absent', async () => {
  const found = dependencies('/p/gate-made/v1/models', {
    providerStore: {
      async get() {
        return { state: { catalog: { models: [{ id: 'v2-model' }, {}, { id: '' }] } } };
      },
    },
    state: { providers: [{ id: 'gate-made', config: { models: ['legacy-model'] } }] },
  });
  assert.equal(await handleProviderRoute(found), true);
  assert.equal(found.res.status, 200);
  assert.deepEqual(found.res.json(), {
    object: 'list',
    data: [{ id: 'v2-model', provider: 'gate-made', label: 'v2-model', object: 'model' }],
  });

  const absent = dependencies('/p/unknown/v1/models');
  assert.equal(await handleProviderRoute(absent), true);
  assert.equal(absent.res.status, 404);
  assert.deepEqual(absent.res.json(), {
    error: 'Not Found',
    message: 'Provider unknown not found',
  });
});

test('scoped backend catalogue returns curated rows and reports catalogue errors', async () => {
  const curated = [];
  const deps = dependencies('/v1/models?backendId=hermes-local&refresh=1', {
    async resolveConversationScope(backendId, botId) {
      assert.equal(backendId, 'hermes-local');
      assert.equal(botId, undefined);
      return { backend: { async listModels() { throw new Error('must use cached catalogue'); } }, environmentId: 'hermes-local' };
    },
    modelRouter: {
      async cataloguesFor(descriptors, options) {
        assert.deepEqual(descriptors, [{ id: 'hermes-local' }]);
        assert.deepEqual(options, { refresh: true });
        return new Map([['hermes-local', [{ id: 'model-a' }]]]);
      },
    },
    curateModels(models, options) {
      curated.push({ models, options });
      return models;
    },
  });
  assert.equal(await handleProviderRoute(deps), true);
  assert.equal(deps.res.status, 200);
  assert.deepEqual(deps.res.json(), {
    object: 'list',
    data: [{ id: 'model-a', object: 'model', backendId: 'hermes-local' }],
  });
  assert.equal(curated.length, 1);
  assert.equal(curated[0].options.health, deps.modelHealth);

  const failed = dependencies('/v1/models?backendId=hermes-local', {
    async resolveConversationScope() {
      return { backend: {}, environmentId: 'hermes-local' };
    },
    modelRouter: { async cataloguesFor() { return new Map(); } },
  });
  assert.equal(await handleProviderRoute(failed), true);
  assert.equal(failed.res.status, 502);
  assert.deepEqual(failed.res.json(), {
    error: { message: 'Environment "hermes-local" did not answer with a model list.', code: 'backend_error' },
  });
});

test('aggregate catalogue combines provider and backend models before curation', async () => {
  const curation = [];
  const deps = dependencies('/v1/models', {
    state: {
      providers: [
        { id: 'alpha', config: { models: ['bootstrap-model'] } },
        { id: 'disabled', config: { models: ['disabled-model'] } },
      ],
    },
    async listProvidersOrEmpty() {
      return [
        { id: 'alpha', catalog: { source: 'live', models: [{ id: 'catalog-model' }] } },
        { id: 'disabled', readiness: { state: 'disabled' }, catalog: { models: [{ id: 'disabled-model' }] } },
      ];
    },
    backendManager: { async list() { return [{ id: 'hermes-local' }]; } },
    modelRouter: {
      async cataloguesFor(descriptors, options) {
        assert.deepEqual(descriptors, [{ id: 'hermes-local' }]);
        assert.deepEqual(options, { refresh: false });
        return new Map([['hermes-local', [{ id: 'backend-model' }]]]);
      },
    },
    curateModels(models, options) {
      curation.push({ models, options });
      return models;
    },
  });

  assert.equal(await handleProviderRoute(deps), true);
  assert.equal(deps.res.status, 200);
  assert.deepEqual(deps.res.json(), {
    object: 'list',
    data: [
      {
        id: 'catalog-model', provider: 'alpha', providerId: 'alpha', label: 'catalog-model',
        object: 'model', catalogSource: 'live',
      },
      { id: 'backend-model', object: 'model', backendId: 'hermes-local' },
    ],
  });
  assert.equal(curation.length, 1);
  assert.deepEqual(curation[0].models, deps.res.json().data);
  assert.equal(curation[0].options.health, deps.modelHealth);
});

test('unmatched requests are not handled', async () => {
  const deps = dependencies('/v1/models', { method: 'POST' });
  assert.equal(await handleProviderRoute(deps), false);
  assert.equal(deps.res.status, undefined);
});
