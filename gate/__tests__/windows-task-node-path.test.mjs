import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execPath } from 'node:process';
import { buildTaskDefinition } from '../core/service/windows-task.mjs';

test('scheduled task defaults to the current Node executable and allows an override', () => {
  assert.ok(buildTaskDefinition({ user: 'operator' }).xml.includes(execPath));
  assert.match(buildTaskDefinition({ user: 'operator', nodeExe: 'C:\\custom\\node.exe' }).xml, /custom/);
});
