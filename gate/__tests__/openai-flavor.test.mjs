import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildChatRequest, parseDelta, parseResponseText } from '../flavors/openai.mjs';

const config = {
  flavor: 'openai',
  baseUrl: 'https://api.x.ai/v1',
  apiKeyEnv: 'XAI_API_KEY',
  models: ['grok-4'],
  capabilities: { chat: true, streaming: true },
};

test('targets the chat completions endpoint with the bearer key', () => {
  const request = buildChatRequest(config, 'test-key', {
    model: 'grok-4',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
  });

  assert.equal(request.url, 'https://api.x.ai/v1/chat/completions');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers.Authorization, 'Bearer test-key');
  assert.equal(JSON.parse(request.init.body).stream, true);
});

test('falls back to the first configured model when none is given', () => {
  const request = buildChatRequest(config, 'k', {
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(JSON.parse(request.init.body).model, 'grok-4');
});

test('rejects a model the provider did not declare', () => {
  assert.throws(
    () => buildChatRequest(config, 'k', { model: 'gpt-5', messages: [] }),
    /gpt-5/,
  );
});

test('extracts the text delta from a streaming chunk', () => {
  const chunk = JSON.stringify({ choices: [{ delta: { content: 'hello' } }] });
  assert.equal(parseDelta(chunk), 'hello');
});

test('returns empty string for a chunk with no content', () => {
  assert.equal(parseDelta(JSON.stringify({ choices: [{ delta: {} }] })), '');
  assert.equal(parseDelta('not json'), '');
});

test('extracts the message text from a non-streaming response', () => {
  const json = { choices: [{ message: { role: 'assistant', content: 'hello there' } }] };
  assert.equal(parseResponseText(json), 'hello there');
});

test('returns empty string when the response has no message content', () => {
  assert.equal(parseResponseText({ choices: [] }), '');
  assert.equal(parseResponseText({}), '');
});
