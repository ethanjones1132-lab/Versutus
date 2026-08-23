import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDescription } from '../core/cli-environments/hermes-profiles.mjs';
import { upsertProfileDescription } from '../core/cli-environments/hermes-bot-edit.mjs';

test('upsert replaces a plain one-line description and keeps neighbours', () => {
  const before = 'display_name: coder\n' + 'description: Writes patches\n' + 'created: 2026-08-22\n';
  const after = upsertProfileDescription(before, 'Ships reviews');
  assert.equal(after, 'display_name: coder\n' + 'description: Ships reviews\n' + 'created: 2026-08-22\n');
  assert.equal(parseDescription(after), 'Ships reviews');
});

test('upsert folds multi-line input into the single scalar the parser reads', () => {
  const after = upsertProfileDescription('display_name: coder\n', 'Reads code\nand writes findings\ttoday');
  assert.equal(after, 'display_name: coder\ndescription: Reads code and writes findings today\n');
  assert.equal(parseDescription(after), 'Reads code and writes findings today');
});

test('upsert removes folded continuation lines left by the CLI writer', () => {
  const cliFolded = 'description: one\r\n  two.\r\ndisplay_name: coder\r\n';
  const after = upsertProfileDescription(cliFolded, 'concise now');
  assert.equal(after, 'description: concise now\r\ndisplay_name: coder\r\n');
  assert.equal(parseDescription(after), 'concise now');
});

test('upsert quotes scalars with YAML-hostile characters and round-trips', () => {
  const after = upsertProfileDescription('', 'Type "code": fast & careful');
  assert.equal(after, 'description: "Type \\"code\\": fast & careful"\n');
  assert.equal(parseDescription(after), 'Type "code": fast & careful');
});

test('empty value removes the description line without touching other keys', () => {
  const before = 'display_name: coder\ndescription: old\ncreated: 2026-08-22\n';
  const after = upsertProfileDescription(before, '   ');
  assert.equal(after, 'display_name: coder\ncreated: 2026-08-22\n');
  assert.equal(parseDescription(after), null);
});

test('removing an absent description is a no-op', () => {
  const before = 'display_name: coder\ncreated: 2026-08-22\n';
  assert.equal(upsertProfileDescription(before, ''), before);
});

test('appending to a file without a description lands at column zero', () => {
  const after = upsertProfileDescription('model:\n  default: gpt\n', 'Reviewer bot');
  assert.equal(after, 'model:\n  default: gpt\ndescription: Reviewer bot\n');
  assert.equal(parseDescription(after), 'Reviewer bot');
});

test('appending into a CRLF file keeps its line endings', () => {
  const after = upsertProfileDescription('display_name: coder\r\n', 'Reviewer bot');
  assert.equal(after, 'display_name: coder\r\ndescription: Reviewer bot\r\n');
});

test('editing one line leaves every other line byte-for-byte, even with mixed endings', () => {
  const before = 'a: 1\r\ndescription: old\nb: 2\r\n';
  const after = upsertProfileDescription(before, 'new');
  assert.equal(after, 'a: 1\r\ndescription: new\nb: 2\r\n');
});
