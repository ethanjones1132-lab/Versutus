import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateId,
  templateValueForField,
  buildInstanceConfigTemplate,
  getKindTemplate,
} from '../core/cli-helpers.mjs';

test('validateId accepts lowercase alphanumeric with hyphens', () => {
  assert.equal(validateId('my-kind-1'), true);
});

test('validateId rejects uppercase, spaces, and empty', () => {
  assert.equal(validateId('My-Kind'), false);
  assert.equal(validateId('bad id'), false);
  assert.equal(validateId(''), false);
  assert.equal(validateId(undefined), false);
});

test('templateValueForField uses the declared default when present', () => {
  assert.equal(templateValueForField({ type: 'boolean', default: true }), true);
  assert.equal(templateValueForField({ type: 'string', default: 'x' }), 'x');
});

test('templateValueForField returns a type-appropriate placeholder when no default', () => {
  assert.equal(templateValueForField({ type: 'string' }), '');
  assert.deepEqual(templateValueForField({ type: 'string-list' }), []);
  assert.equal(templateValueForField({ type: 'number' }), 0);
  assert.equal(templateValueForField({ type: 'boolean' }), false);
  assert.equal(templateValueForField({ type: 'secret-ref' }), 'ENV_VAR_NAME_HERE');
});

test('templateValueForField uses the first enum option when no default', () => {
  assert.equal(templateValueForField({ type: 'enum', options: ['a', 'b'] }), 'a');
});

test('templateValueForField falls back to empty string for an enum with no options', () => {
  assert.equal(templateValueForField({ type: 'enum' }), '');
});

test('buildInstanceConfigTemplate builds one entry per configField, keyed correctly', () => {
  const configFields = [
    { key: 'flavor', type: 'enum', options: ['openai', 'anthropic'] },
    { key: 'apiKeyEnv', type: 'secret-ref' },
    { key: 'models', type: 'string-list' },
    { key: 'streaming', type: 'boolean', default: true },
  ];
  assert.deepEqual(buildInstanceConfigTemplate(configFields), {
    flavor: 'openai',
    apiKeyEnv: 'ENV_VAR_NAME_HERE',
    models: [],
    streaming: true,
  });
});

test('buildInstanceConfigTemplate returns an empty object for no fields', () => {
  assert.deepEqual(buildInstanceConfigTemplate([]), {});
  assert.deepEqual(buildInstanceConfigTemplate(undefined), {});
});

test('getKindTemplate produces importable ESM naming the given kind/label/family', () => {
  const source = getKindTemplate('cron', 'Scheduled jobs', 'cron');
  assert.match(source, /kind: "cron"/);
  assert.match(source, /label: "Scheduled jobs"/);
  assert.match(source, /family: "cron"/);
  assert.match(source, /export default \{/);
});

test('getKindTemplate output is actually valid, importable JS', async () => {
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');

  const dir = await mkdtemp(join(tmpdir(), 'cli-helpers-kind-'));
  const filePath = join(dir, 'kind.mjs');
  await writeFile(filePath, getKindTemplate('cron', 'Scheduled jobs', 'cron'), 'utf8');

  const module = await import(pathToFileURL(filePath).href);
  assert.equal(module.default.kind, 'cron');
  assert.equal(module.default.label, 'Scheduled jobs');
  assert.equal(module.default.family, 'cron');
  assert.deepEqual(module.default.configFields, []);
  assert.deepEqual(module.default.validate({}), { ok: true, errors: [] });
  assert.deepEqual(module.default.createHandlers({ id: 'x' }), {});
});

test('getKindTemplate safely escapes a label containing a quote and apostrophe', async () => {
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');

  const dir = await mkdtemp(join(tmpdir(), 'cli-helpers-kind-quote-'));
  const filePath = join(dir, 'kind.mjs');
  await writeFile(filePath, getKindTemplate('note', `O'Brien's "Notes"`, 'note'), 'utf8');

  const module = await import(pathToFileURL(filePath).href);
  assert.equal(module.default.label, `O'Brien's "Notes"`);
});
