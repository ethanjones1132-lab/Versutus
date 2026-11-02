import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RotatingLog } from '../core/service/rotating-log.mjs';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-rotlog-rename-'));
  return fn(dir);
}

// A rotation that cannot move the current file aside (a Windows sharing
// violation, a read-only directory, an occupied destination) is a disk
// problem, not a reason to lose a log line. The write must still land.
test('a failed rotation rename neither throws out of write nor drops the chunk', () => {
  withDir((dir) => {
    // Occupying `gate.log.1` with a non-empty directory makes both the
    // generation cleanup and the final rename fail on every platform, with no
    // mocked fs and no platform-specific timing.
    mkdirSync(join(dir, 'gate.log.1'));
    writeFileSync(join(dir, 'gate.log.1', 'blocker'), 'x');

    const log = new RotatingLog(dir, { maxBytes: 10, keep: 1 });
    log.write('gate', 'first line, before any rotation is attempted\n');
    assert.doesNotThrow(
      () => log.write('gate', 'the chunk that must survive a failed rotation\n'),
      'write must not throw when rotation fails',
    );

    const text = readFileSync(join(dir, 'gate.log'), 'utf8');
    assert.match(text, /\[gate\] first line, before any rotation is attempted\n/);
    assert.match(text, /\[gate\] the chunk that must survive a failed rotation\n/);
  });
});

test('after a failed rotation the log keeps accepting lines instead of wedging', () => {
  withDir((dir) => {
    mkdirSync(join(dir, 'gate.log.1'));
    writeFileSync(join(dir, 'gate.log.1', 'blocker'), 'x');

    const log = new RotatingLog(dir, { maxBytes: 10, keep: 1 });
    log.write('supervisor', 'one\n');
    log.write('supervisor', 'two\n');
    log.write('supervisor', 'three\n');

    const text = readFileSync(join(dir, 'gate.log'), 'utf8');
    for (const line of ['one', 'two', 'three']) {
      assert.match(text, new RegExp(`\\[supervisor\\] ${line}\\n`));
    }
  });
});

test('when rotation succeeds the generations are still named and capped as before', () => {
  withDir((dir) => {
    const log = new RotatingLog(dir, { maxBytes: 100, keep: 5 });
    for (let i = 0; i < 30; i += 1) log.write('supervisor', `event number ${i} with padding xxxxxxxxxx\n`);

    // gate.log.5 holds the oldest kept generation and gate.log.6 never appears.
    assert.match(readFileSync(join(dir, 'gate.log.5'), 'utf8'), /\[supervisor\] event number \d+/);
    assert.throws(() => readFileSync(join(dir, 'gate.log.6'), 'utf8'), /ENOENT/);
    assert.ok(readFileSync(join(dir, 'gate.log.1')).length <= 100 + 64);
  });
});
