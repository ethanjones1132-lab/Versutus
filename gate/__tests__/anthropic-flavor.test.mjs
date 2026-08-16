import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildChatRequest, parseDelta, parseResponseText } from '../flavors/anthropic.mjs';

const config = {
  flavor: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  models: ['claude-opus-5'],
  capabilities: { chat: true, streaming: true },
};

test('targets the messages endpoint without resolving auth', () => {
  const request = buildChatRequest(config, 'test-key', {
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.init.headers['x-api-key'], undefined);
  assert.equal(request.init.headers['anthropic-version'], '2023-06-01');
  assert.equal(request.init.headers.Authorization, undefined);
});

test('moves a system message out of messages and into the system field', () => {
  const request = buildChatRequest(config, 'k', {
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ],
  });
  const body = JSON.parse(request.init.body);
  assert.equal(body.system, 'be terse');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
});

test('joins multiple system messages with a blank line', () => {
  const request = buildChatRequest(config, 'k', {
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'system', content: 'use metric units' },
      { role: 'user', content: 'hi' },
    ],
  });
  const body = JSON.parse(request.init.body);
  assert.equal(body.system, 'be terse\n\nuse metric units');
});

test('applies a default max_tokens when none is given', () => {
  const request = buildChatRequest(config, 'k', { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(JSON.parse(request.init.body).max_tokens, 4096);
});

test('rejects a model the provider did not declare', () => {
  assert.throws(
    () => buildChatRequest(config, 'k', { model: 'gpt-5', messages: [] }),
    /gpt-5/,
  );
});

test('extracts text from a content_block_delta event', () => {
  const chunk = JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } });
  assert.equal(parseDelta(chunk), 'hi');
});

test('ignores non-text-delta events', () => {
  assert.equal(parseDelta(JSON.stringify({ type: 'message_start' })), '');
  assert.equal(parseDelta(JSON.stringify({ type: 'ping' })), '');
  assert.equal(parseDelta('not json'), '');
});

test('joins text blocks from a non-streaming response', () => {
  const json = { content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'there' }] };
  assert.equal(parseResponseText(json), 'hello there');
});

test('parseResponseText returns empty string for a response with no text blocks', () => {
  assert.equal(parseResponseText({ content: [] }), '');
  assert.equal(parseResponseText({}), '');
});
