import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCliEnvironment } from '../core/cli-environments/process-environment.mjs';

const request = { environmentId: 'hermes-local', runId: 'run-1' };

// Windows reports its variables as the OS spells them: `Path`, `SystemRoot`,
// `windir`, `ComSpec`. The child has to receive them under those same names.
const windowsParent = {
  Path: 'C:\\Windows\\system32;C:\\Tools',
  SystemRoot: 'C:\\Windows',
  windir: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\system32\\cmd.exe',
  PATHEXT: '.COM;.EXE;.BAT',
  TEMP: 'C:\\Users\\ethan\\AppData\\Local\\Temp',
  USERPROFILE: 'C:\\Users\\ethan',
  OPENAI_API_KEY: 'sk-never',
  RANDOM_THING: 'nope',
};

test('win32 children keep Windows variables under the names the OS gave them', () => {
  const child = buildCliEnvironment(windowsParent, request, { platform: 'win32' });
  for (const key of ['Path', 'SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'USERPROFILE']) {
    assert.equal(child[key], windowsParent[key], `${key} must reach the CLI on win32`);
  }
  // The original spelling is kept, not normalised to upper case.
  assert.equal(child.PATH, undefined);
  assert.equal(child.SYSTEMROOT, undefined);
});

test('win32 still strips provider secrets and unlisted variables', () => {
  const child = buildCliEnvironment(windowsParent, request, { platform: 'win32' });
  assert.equal(child.OPENAI_API_KEY, undefined);
  assert.equal(child.RANDOM_THING, undefined);
});

test('win32 matching is case-insensitive for an all-lower-case name too', () => {
  const child = buildCliEnvironment({ pathext: '.EXE', comspec: 'cmd.exe' }, request, { platform: 'win32' });
  assert.equal(child.pathext, '.EXE');
  assert.equal(child.comspec, 'cmd.exe');
});

test('posix names stay case-sensitive: a mixed-case Path is not PATH', () => {
  const child = buildCliEnvironment({ Path: '/usr/bin', PATH: '/bin' }, request, { platform: 'linux' });
  assert.equal(child.PATH, '/bin');
  assert.equal(child.Path, undefined);
});
