import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildManifest } from '../core/manifest.mjs';

/**
 * The app renders what the manifest claims. Advertising only {chat, models}
 * while serving providers, environments and a capability registry makes the
 * Gate look nearly featureless next to Hermes — the endpoints are there, but
 * nothing tells a client they exist as capabilities.
 */
test('capabilities cover everything the Gate actually serves', () => {
  const manifest = buildManifest({ name: 'Gate', capabilityKinds: [], capabilityInstances: [] });
  assert.equal(manifest.capabilities.chat, true);
  assert.equal(manifest.capabilities.models, true);
  assert.equal(manifest.capabilities.providers, true);
  assert.equal(manifest.capabilities.environments, true);
  assert.equal(manifest.capabilities.capabilityRegistry, true);
  assert.equal(manifest.capabilities.streaming, true);
});

test('every advertised capability has an endpoint backing it', () => {
  const manifest = buildManifest({ name: 'Gate', capabilityKinds: [], capabilityInstances: [] });
  const backing = {
    chat: 'chat',
    models: 'models',
    providers: 'providers',
    environments: 'environments',
    capabilityRegistry: 'capabilitiesRpc',
  };
  for (const [capability, endpoint] of Object.entries(backing)) {
    if (manifest.capabilities[capability]) {
      assert.ok(manifest.endpoints[endpoint], `${capability} advertised without an ${endpoint} endpoint`);
    }
  }
});

test('capabilities the Gate does not implement stay absent', () => {
  const manifest = buildManifest({ name: 'Gate', capabilityKinds: [], capabilityInstances: [] });
  // The Gate has no conversation sessions, generic runs, approvals or terminal.
  // Claiming them would make the app offer surfaces that cannot work.
  for (const absent of ['sessions', 'runs', 'approvals', 'terminal']) {
    assert.notEqual(manifest.capabilities[absent], true, `${absent} must not be advertised`);
  }
});
