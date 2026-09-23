// Pin for the smoke:live test-push classifier (../smoke-live-push-check.mjs).
//
// Solution A5's verify step (FUTURE-ITEMS.md, plan 2026-09-11 G6): smoke:live
// dispatches `notifications.test` when the target advertises it. The classifier
// is the only thing that turns the Gate's answer into a line of smoke output,
// so its three-way split is the contract: a structured `{ skipped: 'no-token' }`
// is an honest skip (operator laptop, no phone under this harness id — the
// suite must not fail for a missing phone), a ticketed send is PASS, and a
// failed or unrecognised answer is FAIL (a broken relay must never read as
// green). Advertisement itself is a fact read from the gateway's own
// `rpcMethods` table, never inferred from its kind.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { advertisesTestPush, classifyTestPushResult } from '../smoke-live-push-check.mjs';

test('dispatch runs only against a gateway advertising notifications.test', () => {
  assert.equal(advertisesTestPush({ rpcMethods: ['cron.jobs', 'notifications.test'] }), true);
  assert.equal(advertisesTestPush({ rpcMethods: ['cron.jobs'] }), false);
  assert.equal(advertisesTestPush({ rpcMethods: [] }), false);
  assert.equal(advertisesTestPush({ rpcMethods: 'notifications.test' }), false);
  assert.equal(advertisesTestPush({}), false);
  assert.equal(advertisesTestPush(null), false);
  assert.equal(advertisesTestPush(undefined), false);
});

test('a structured no-token answer is an honest skip, not a failure', () => {
  const verdict = classifyTestPushResult({ skipped: 'no-token' });
  assert.equal(verdict.status, 'skip');
  assert.match(verdict.detail, /no registered device token/i);
  assert.ok(verdict.detail.length > 0);
});

test('a ticketed send passes and reports how many tickets came back', () => {
  const verdict = classifyTestPushResult({
    ok: true,
    tickets: [{ status: 'ok', id: 'ticket-0' }],
    receipts: [],
    deadTokens: [],
  });
  assert.equal(verdict.status, 'pass');
  assert.match(verdict.detail, /1 ticket/);
});

test('a failed Expo send fails with the error carried in the detail', () => {
  const verdict = classifyTestPushResult({ ok: false, error: 'Expo Push API responded with 500' });
  assert.equal(verdict.status, 'fail');
  assert.match(verdict.detail, /Expo Push API responded with 500/);
});

test('a failed send with no error string still fails with a readable detail', () => {
  const verdict = classifyTestPushResult({ ok: false });
  assert.equal(verdict.status, 'fail');
  assert.ok(verdict.detail.length > 0);
});

test('malformed answers fail rather than reading as success', () => {
  const malformed = [
    null,
    undefined,
    'ok',
    42,
    [],
    {},
    { ok: true },
    { ok: true, tickets: [] },
  ];
  for (const result of malformed) {
    const verdict = classifyTestPushResult(result);
    assert.equal(verdict.status, 'fail', `result ${JSON.stringify(result)} must fail`);
    assert.ok(verdict.detail.length > 0, `result ${JSON.stringify(result)} needs a detail`);
  }
});
