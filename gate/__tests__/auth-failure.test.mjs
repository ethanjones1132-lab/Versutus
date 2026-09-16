import assert from 'node:assert/strict';
import test from 'node:test';

import { describeAuthFailure } from '../core/auth-failure.mjs';

test('names the route and whether a bearer arrived, never the token', () => {
  const secret = 'Z3ZfYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODk';
  const line = describeAuthFailure({
    method: 'GET',
    pathname: '/v1/terminal/stream',
    authorization: `Bearer ${secret}`,
  });
  assert.match(line, /GET \/v1\/terminal\/stream/);
  assert.match(line, /bearer present/);
  assert.match(line, new RegExp(`${secret.length} chars`));
  // The whole point is to diagnose a refusal without leaking what was refused.
  assert.equal(line.includes(secret), false);
  assert.equal(line.includes(secret.slice(0, 8)), false);
});

test('tells a missing header apart from a malformed one', () => {
  assert.match(
    describeAuthFailure({ method: 'GET', pathname: '/v1/bots', authorization: undefined }),
    /no authorization header/,
  );
  assert.match(
    describeAuthFailure({ method: 'GET', pathname: '/v1/bots', authorization: 'Basic abc' }),
    /not a bearer/,
  );
  assert.match(
    describeAuthFailure({ method: 'GET', pathname: '/v1/bots', authorization: 'Bearer ' }),
    /empty bearer/,
  );
});
