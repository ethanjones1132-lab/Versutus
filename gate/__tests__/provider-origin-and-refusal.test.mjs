import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createProviderAdapter } from '../core/providers/factory.mjs';
import { createProfileAdapter } from '../core/providers/profiles/registry.mjs';
import { openaiCompatibleProfile } from '../core/providers/profiles/openai-compatible.mjs';

// Two defects in the same three functions.
//
// `assertAllowedOrigin` compared `new URL(baseUrl).origin` against an allowlist
// whose first element was that same origin, so it could never refuse: the four
// shipped profiles' `origins` were dead configuration and a mistyped base URL
// sent the key to whatever host it named.
//
// And every non-2xx threw on `response.status` alone. The vendor's own
// explanation was never read, so the phone saw `chat failed: 429` where the
// legacy path showed what the vendor said, and the connection undici could not
// return to its pool was left holding the body.

/** No request is made by any of these: the refusal happens in the adapter. */
function registration({ providerType, baseUrl }) {
  return {
    schemaVersion: 2,
    kind: 'provider',
    id: 'openai-main',
    label: 'OpenAI API',
    providerType,
    enabled: true,
    registration: {
      mode: 'api_key',
      protocol: 'openai_chat',
      baseUrl,
      credentialRef: 'provider-openai-main-api-key',
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 120000 },
  };
}

function adapterFor(providerType, baseUrl) {
  return createProviderAdapter(registration({ providerType, baseUrl }), {
    vault: { get: async () => 'the-key' },
    store: { get: async () => null },
  });
}

test('an openai registration pointed off the profile origin is refused', async () => {
  await assert.rejects(
    () => adapterFor('openai', 'https://evil.example/v1').listModels(),
    /origin https:\/\/evil\.example is not allowed/,
  );
  // Same through the chat path, which asserted the origin separately.
  await assert.rejects(
    () => adapterFor('openai', 'https://evil.example/v1').chat({ model: 'gpt-4o', messages: [] }),
    /origin https:\/\/evil\.example is not allowed/,
  );
});

test('a lookalike host on the profile\'s domain is refused too', async () => {
  await assert.rejects(
    () => adapterFor('openai', 'https://api.openai.com.evil.example/v1').listModels(),
    /origin https:\/\/api\.openai\.com\.evil\.example is not allowed/,
  );
});

test('openai-compatible keeps the operator\'s own endpoint as its boundary', async () => {
  assert.deepEqual(openaiCompatibleProfile.origins, [], 'this profile pins nothing by design');
  // `.invalid` never resolves, so this fails on the network rather than on the
  // allowlist: the point is which refusal it is NOT.
  await assert.rejects(
    () => adapterFor('openai-compatible', 'https://no-such-host.invalid/v1').listModels(),
    (error) => {
      assert.doesNotMatch(error.message, /is not allowed/);
      return true;
    },
  );
});

/** A refusal whose body the vendor spent words on, and a body that must be released. */
function refusal({ status, body, drained }) {
  return {
    ok: false,
    status,
    text: async () => {
      drained.push(true);
      return body;
    },
    body: {
      cancel: async () => { drained.push('cancelled'); },
    },
  };
}

test('a vendor refusal carries the vendor\'s own explanation, and its body is consumed', async () => {
  const drained = [];
  const adapter = createProfileAdapter({
    profileId: 'openai',
    providerId: 'openai-main',
    baseUrl: 'https://api.openai.com/v1',
    credential: 'the-key',
    fetchImpl: async () => refusal({
      status: 429,
      body: '{"error":{"message":"Rate limit reached for gpt-4o. Try again in 20s."}}',
      drained,
    }),
  });

  await assert.rejects(
    () => adapter.chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    (error) => {
      assert.equal(error.status, 429);
      assert.match(error.message, /429/);
      // The explanation, not just the number: a retry-after only the vendor knows.
      assert.match(error.message, /Rate limit reached for gpt-4o/);
      return true;
    },
  );
  assert.deepEqual(drained, [true], 'the body was read, so undici can reuse the connection');
});

test('a refusal with an unreadable body still fails with its status', async () => {
  const drained = [];
  const adapter = createProfileAdapter({
    profileId: 'openai',
    providerId: 'openai-main',
    baseUrl: 'https://api.openai.com/v1',
    credential: 'the-key',
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      text: async () => { throw new Error('socket hang up'); },
      body: { cancel: async () => { drained.push('cancelled'); } },
    }),
  });

  await assert.rejects(
    () => adapter.chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.message, 'chat failed: 401');
      return true;
    },
  );
  assert.deepEqual(drained, ['cancelled'], 'an unreadable body is cancelled, not leaked');
});

test('a large vendor refusal is not fully buffered', async () => {
  let pulled = 0;
  const chunk = new Uint8Array(1024).fill(0x78);
  const adapter = createProfileAdapter({
    profileId: 'openai',
    providerId: 'openai-main',
    baseUrl: 'https://api.openai.com/v1',
    credential: 'the-key',
    fetchImpl: async () => new Response(
      new ReadableStream({
        pull(controller) {
          pulled += 1;
          if (pulled > 20) {
            controller.close();
            return;
          }
          controller.enqueue(chunk);
        },
      }),
      { status: 429, headers: { 'content-type': 'text/plain' } },
    ),
  });

  await assert.rejects(
    () => adapter.chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    (error) => {
      assert.equal(error.status, 429);
      assert.match(error.message, /429/);
      return true;
    },
  );
  assert.ok(
    pulled <= 2,
    `read ${pulled} KiB chunks of a 20 KiB body; the refusal was fully buffered then sliced`,
  );
});

test('a catalog refusal carries the vendor body too, keeping the nvidia catalog code', async () => {
  const adapter = createProfileAdapter({
    profileId: 'nvidia-nim',
    providerId: 'nvidia',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    credential: 'the-key',
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      text: async () => 'no models endpoint',
      body: { cancel: async () => {} },
    }),
  });

  await assert.rejects(() => adapter.listModels(), (error) => {
    assert.equal(error.code, 'catalog_timeout');
    assert.match(error.message, /no models endpoint/);
    return true;
  });
});
