import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createProfileAdapter, getProfile, releaseProfiles } from '../core/providers/profiles/registry.mjs';

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        origin: `http://127.0.0.1:${port}`,
      });
    });
  });
}

test('OpenAI profile obtains its catalog from authenticated /v1/models', async () => {
  const seen = {};
  const { server, baseUrl, origin } = await listen((req, res) => {
    seen.auth = req.headers.authorization;
    seen.url = req.url;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'gpt-test' }] }));
  });
  after(() => server.close());

  const adapter = createProfileAdapter({
    profileId: 'openai',
    providerId: 'openai-main',
    baseUrl,
    credential: 'test-key',
    allowedOrigins: [origin],
  });
  const models = await adapter.listModels();
  assert.deepEqual(models.map((model) => model.id), ['gpt-test']);
  assert.equal(models[0].providerId, 'openai-main');
  assert.equal(seen.auth, 'Bearer test-key');
  assert.equal(seen.url, '/v1/models');
});

test('profiles pin official origins and reject others', async () => {
  await assert.rejects(
    () => createProfileAdapter({
      profileId: 'openai',
      providerId: 'openai-main',
      baseUrl: 'https://evil.example/v1',
      credential: 'test-key',
    }).listModels(),
    /origin/i,
  );
});

test('xAI ships as official API-key access, not consumer OAuth', () => {
  const profile = getProfile('xai');
  assert.equal(profile.label, 'xAI API');
  assert.equal(profile.mode, 'api_key');
  assert.equal(profile.oauth, undefined);
  assert.ok(!releaseProfiles.has('xai-consumer'));
});

test('OpenAI official label is OpenAI API, not ChatGPT', () => {
  assert.equal(getProfile('openai').label, 'OpenAI API');
});

test('profile chat uses the flavor codec plus profile auth headers', async () => {
  const seen = {};
  const { server, baseUrl, origin } = await listen((req, res) => {
    seen.auth = req.headers.authorization;
    seen.url = req.url;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
      }));
    });
  });
  after(() => server.close());

  const adapter = createProfileAdapter({
    profileId: 'openai',
    providerId: 'openai-main',
    baseUrl,
    credential: 'test-key',
    allowedOrigins: [origin],
  });
  const result = await adapter.chat({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(seen.auth, 'Bearer test-key');
  assert.equal(seen.url, '/v1/chat/completions');
  assert.equal(seen.body.model, 'gpt-test');
  assert.equal(result.choices[0].message.content, 'ok');
});

test('NVIDIA keeps a catalog error so LKG/bootstrap stays visible', async () => {
  const { server, baseUrl, origin } = await listen((_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'no models endpoint' }));
  });
  after(() => server.close());

  const adapter = createProfileAdapter({
    profileId: 'nvidia-nim',
    providerId: 'nvidia',
    baseUrl,
    credential: 'test-key',
    allowedOrigins: [origin],
  });
  await assert.rejects(() => adapter.listModels(), (error) => {
    assert.equal(error.code, 'catalog_timeout');
    return true;
  });
});
