import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyProviderError } from '../core/providers/errors.mjs';
import { readinessFromAuthAndError } from '../core/providers/health.mjs';

test('maps provider failures to distinct codes', () => {
  assert.equal(classifyProviderError({ status: 401 }), 'invalid_credentials');
  assert.equal(classifyProviderError({ status: 403 }), 'entitlement_denied');
  assert.equal(classifyProviderError({ status: 429 }), 'rate_limited');
  assert.equal(classifyProviderError({ status: 529 }), 'overloaded');
  assert.equal(classifyProviderError({ code: 'ENOTFOUND' }), 'transient_network');
});

test('Gate health is never used as provider readiness', () => {
  const readiness = readinessFromAuthAndError({
    enabled: true,
    authState: 'ready',
    error: { status: 401 },
    gateHealthy: true,
  });
  assert.equal(readiness.state, 'unavailable');
  assert.equal(readiness.code, 'invalid_credentials');
});
