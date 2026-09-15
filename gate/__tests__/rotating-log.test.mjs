import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RotatingLog } from '../core/service/rotating-log.mjs';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-rotlog-'));
  return fn(dir);
}

test('lines are timestamped, sourced, and partial chunks are joined', () => {
  withDir((dir) => {
    const log = new RotatingLog(dir);
    log.write('gate', 'Listening on');
    log.write('gate', ' port 8760\nSecond line\n');
    const text = readFileSync(join(dir, 'gate.log'), 'utf8');
    assert.match(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[gate\] Listening on port 8760/);
    assert.match(text, /\[gate\] Second line/);
  });
});

test('the bootstrap token never lands on disk', () => {
  withDir((dir) => {
    const log = new RotatingLog(dir);
    log.write('gate', 'Token: secret-bytes-here\nListening on port 8760\n');
    const text = readFileSync(join(dir, 'gate.log'), 'utf8');
    assert.doesNotMatch(text, /secret-bytes-here/);
    assert.match(text, /Token: \[redacted\]/);
  });
});

test('rotation keeps 5 generations past a 10 MB default', () => {
  withDir((dir) => {
    const log = new RotatingLog(dir, { maxBytes: 100, keep: 5 });
    for (let i = 0; i < 30; i += 1) log.write('supervisor', `event number ${i} with padding xxxxxxxxxx\n`);
    assert.ok(existsSync(join(dir, 'gate.log.5')), 'keeps gate.log.1…5');
    assert.equal(existsSync(join(dir, 'gate.log.6')), false);
  });
});

test('a chunk that finishes a held line and ends in a new partial keeps both lines whole', () => {
  withDir((dir) => {
    const log = new RotatingLog(dir);
    log.write('gate', 'Tok');
    log.write('gate', 'en: secret-bytes-here\nListening on port 8760\npart');
    log.write('gate', 'ial line\n');
    const text = readFileSync(join(dir, 'gate.log'), 'utf8');
    assert.doesNotMatch(text, /secret-bytes-here/);
    assert.match(text, /\[gate\] Token: \[redacted\]\n/);
    assert.match(text, /\[gate\] Listening on port 8760\n/);
    assert.match(text, /\[gate\] partial line\n/);
  });
});

test('stdout and stderr hold their own partial lines, so neither splices into the other', () => {
  withDir((dir) => {
    const log = new RotatingLog(dir);
    log.write('gate', 'Tok', 'stdout');
    log.write('gate', 'warning: slow disk\n', 'stderr');
    log.write('gate', 'en: secret-bytes-here\n', 'stdout');
    const text = readFileSync(join(dir, 'gate.log'), 'utf8');
    assert.doesNotMatch(text, /secret-bytes-here/);
    assert.match(text, /\[gate\] warning: slow disk\n/);
    assert.match(text, /\[gate\] Token: \[redacted\]\n/);
  });
});

test('a CRLF split across chunks leaves no stray carriage return', () => {
  withDir((dir) => {
    const log = new RotatingLog(dir);
    log.write('gate', 'first\r');
    log.write('gate', '\nsecond\r\n');
    const text = readFileSync(join(dir, 'gate.log'), 'utf8');
    assert.doesNotMatch(text, /\r/);
    assert.match(text, /\[gate\] first\n/);
    assert.match(text, /\[gate\] second\n/);
  });
});

test('a token named mid-line is still redacted', () => {
  withDir((dir) => {
    const log = new RotatingLog(dir);
    log.write('gate', 'Approved device phone-1. Token: secret-bytes-here\n');
    const text = readFileSync(join(dir, 'gate.log'), 'utf8');
    assert.doesNotMatch(text, /secret-bytes-here/);
    assert.match(text, /Token: \[redacted\]/);
  });
});

test('close() flushes each stream\'s held partial under its own source', () => {
  withDir((dir) => {
    const log = new RotatingLog(dir);
    log.write('gate', 'half a gate line', 'stdout');
    log.write('supervisor', 'half a supervisor line');
    log.close();
    const text = readFileSync(join(dir, 'gate.log'), 'utf8');
    assert.match(text, /\[gate\] half a gate line\n/);
    assert.match(text, /\[supervisor\] half a supervisor line\n/);
  });
});
