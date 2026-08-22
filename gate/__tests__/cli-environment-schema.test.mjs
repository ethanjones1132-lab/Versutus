import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateCliEnvironmentRegistration } from '../core/cli-environments/schema.mjs';
import { validEnvironment } from './fixtures/cli-environment.mjs';

test('rejects provider state on a CLI environment', () => {
  const result = validateCliEnvironmentRegistration(validEnvironment({ models: ['gpt'] }));
  assert.equal(result.ok, false);
});

test('rejects credentials, tokens, catalog, and provider auth fields', () => {
  for (const extra of [
    { credentials: { token: 'x' } },
    { tokens: { access_token: 'x' } },
    { catalog: { models: [] } },
    { credentialRef: 'provider/x/api-key' },
    { oauthProfileId: 'openai' },
  ]) {
    const result = validateCliEnvironmentRegistration(validEnvironment(extra));
    assert.equal(result.ok, false, `expected rejection for ${Object.keys(extra)[0]}`);
  }
});

test('rejects an unknown schema version', () => {
  const result = validateCliEnvironmentRegistration(validEnvironment({ schemaVersion: 2 }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.field === 'schemaVersion'));
});

test('accepts a well-formed CLI environment', () => {
  const result = validateCliEnvironmentRegistration(validEnvironment());
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('rejects the path-shredding corruption signature in executable.path', () => {
  // Exact shape observed on disk during the 2026-08 incident: backslashes
  // stripped and "\venv" evaluated into a vertical tab.
  const corrupted = validEnvironment({
    executable: { path: 'C:UsersethanAppDataLocalhermeshermes-agent\u000benvScriptspython.exe' },
  });
  const result = validateCliEnvironmentRegistration(corrupted);
  assert.equal(result.ok, false);
  const error = result.errors.find((entry) => entry.field === 'executable.path');
  assert.ok(error, 'expected an executable.path error');
  assert.match(error.message, /control characters/);
});

test('rejects control characters in workspace roots', () => {
  for (const workspacePolicy of [
    {
      roots: ['C:\u0001broken'],
      defaultRoot: 'C:\\Projects\\Versutus',
      defaultSandbox: 'read_only',
      allowAdditionalRoots: false,
    },
    {
      roots: ['C:\\Projects\\Versutus'],
      defaultRoot: 'C:\\Projects\u007f',
      defaultSandbox: 'read_only',
      allowAdditionalRoots: false,
    },
  ]) {
    const result = validateCliEnvironmentRegistration(validEnvironment({ workspacePolicy }));
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(workspacePolicy.defaultRoot)}`);
    assert.ok(
      result.errors.some((error) => /control characters/.test(error.message)),
      `expected a control-character message for ${JSON.stringify(workspacePolicy)}`,
    );
  }
});

test('accepts operator credential bindings as vault references', () => {
  const result = validateCliEnvironmentRegistration(validEnvironment({
    credentialBindings: { API_SERVER_KEY: 'environment/hermes-local/api-key' },
  }));
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('rejects non-string credential binding references', () => {
  const result = validateCliEnvironmentRegistration(validEnvironment({
    credentialBindings: { API_SERVER_KEY: 42 },
  }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.field === 'credentialBindings.API_SERVER_KEY'));
});
