import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCliEnvironment } from '../core/cli-environments/process-environment.mjs';

const request = { environmentId: 'opencode-local', runId: 'run-1' };
const parent = {
  HOME: '/Users/ethan',
  USER: 'ethan',
  LOGNAME: 'ethan',
  TMPDIR: '/var/folders/xy/T/',
  SHELL: '/bin/zsh',
  LANG: 'en_US.UTF-8',
  PATH: '/usr/bin:/bin',
  OPENAI_API_KEY: 'sk-never',
  GITHUB_ACCESS_TOKEN: 'ghp-never',
  RANDOM_THING: 'nope',
};

for (const platform of ['darwin', 'linux']) {
  test(`${platform} children keep their user identity and scratch space`, () => {
    const child = buildCliEnvironment(parent, request, { platform });
    for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'SHELL', 'LANG', 'PATH']) {
      assert.equal(child[key], parent[key], `${key} must reach the CLI on ${platform}`);
    }
    assert.equal(child.OPENAI_API_KEY, undefined);
    assert.equal(child.GITHUB_ACCESS_TOKEN, undefined);
    assert.equal(child.RANDOM_THING, undefined);
  });
}

test('the Windows allow-list is unchanged: no POSIX additions', () => {
  const child = buildCliEnvironment({ ...parent, USERPROFILE: 'C:\\Users\\ethan', SYSTEMROOT: 'C:\\Windows' }, request, { platform: 'win32' });
  assert.equal(child.HOME, undefined);
  assert.equal(child.SHELL, undefined);
  assert.equal(child.TMPDIR, undefined);
  assert.equal(child.USER, undefined);
  assert.equal(child.USERPROFILE, 'C:\\Users\\ethan');
  assert.equal(child.PATH, '/usr/bin:/bin');
  assert.equal(child.LANG, 'en_US.UTF-8');
});
