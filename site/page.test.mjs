import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the Versutus page is self-contained', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.equal(html.includes('http'), false);
  assert.equal(html.includes('<script'), false);
  assert.equal(html.includes('mobile and web client'), true);
  assert.equal(html.includes('not a public relay'), true);
  assert.equal(html.includes('Hermes'), true);
  assert.equal(html.includes('pre-release'), true);
});
