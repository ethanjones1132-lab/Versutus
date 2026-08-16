import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertWorkspaceAccess } from '../core/cli-environments/workspace-policy.mjs';

const policy = {
  roots: ['C:\\Projects\\Versutus'],
  defaultRoot: 'C:\\Projects\\Versutus',
  defaultSandbox: 'read_only',
  allowAdditionalRoots: false,
};

test('rejects UNC and device paths by default', () => {
  assert.throws(() => assertWorkspaceAccess({ ...policy }, '\\\\server\\share\\file'), /canonical|unc|device|policy/i);
  assert.throws(() => assertWorkspaceAccess({ ...policy }, '\\\\.\\pipe\\x'), /canonical|unc|device|policy/i);
});

test('rejects a workdir that escapes the configured roots', () => {
  assert.throws(
    () => assertWorkspaceAccess(policy, 'C:\\Windows\\System32'),
    /canonical|escape|root|policy/i,
  );
});

test('accepts a path inside a configured root', () => {
  const result = assertWorkspaceAccess(policy, 'C:\\Projects\\Versutus\\docs');
  assert.equal(result.allowed, true);
  assert.match(result.canonical, /Versutus\\docs/i);
});
