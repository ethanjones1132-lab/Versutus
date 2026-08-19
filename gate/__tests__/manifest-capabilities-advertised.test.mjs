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

/**
 * Every capability the Gate can advertise, and the endpoint that proves it.
 *
 * This map used to stop at the five capabilities a backend-less Gate offers,
 * so `tools`, `sessions`, `runs` and `approvals` were exempt — which is how
 * `capabilities.tools: true` survived with no tools route and no backend
 * method behind it, rendering a ready Tools tile over a command that could not
 * run. A capability missing from this map is a capability nothing checks.
 */
const CAPABILITY_BACKING = {
  chat: 'chat',
  models: 'models',
  providers: 'providers',
  environments: 'environments',
  capabilityRegistry: 'capabilitiesRpc',
  sessions: 'sessions',
  tools: 'toolsets',
  runs: 'runs',
  approvals: 'runApproval',
  jobs_admin: 'jobs',
};

function assertFullyBacked(manifest) {
  for (const capability of Object.keys(manifest.capabilities)) {
    if (manifest.capabilities[capability] !== true) continue;
    if (capability === 'streaming') continue; // a modifier on chat, not its own surface
    const endpoint = CAPABILITY_BACKING[capability];
    assert.ok(endpoint, `${capability} is advertised but absent from CAPABILITY_BACKING — add it or stop advertising it`);
    assert.ok(manifest.endpoints[endpoint], `${capability} advertised without an ${endpoint} endpoint`);
  }
}

test('every advertised capability has an endpoint backing it', () => {
  assertFullyBacked(buildManifest({ name: 'Gate', capabilityKinds: [], capabilityInstances: [] }));
});

test('capabilities a backend unlocks are backed too', () => {
  // A backend-less Gate never advertises sessions/tools/runs/approvals, so the
  // bare manifest cannot exercise their backing. This is the one that matters.
  const manifest = buildManifest({
    name: 'Gate',
    capabilityKinds: [],
    capabilityInstances: [],
    backends: [{ id: 'hermes', kind: 'hermes', capabilities: ['chat', 'tools', 'sessions', 'models', 'runs'] }],
  });
  assert.equal(manifest.capabilities.tools, true);
  assert.equal(manifest.endpoints.toolsets, '/v1/toolsets');
  assertFullyBacked(manifest);
});

test('capabilities the Gate does not implement stay absent', () => {
  const manifest = buildManifest({ name: 'Gate', capabilityKinds: [], capabilityInstances: [] });
  // The Gate has no conversation sessions, generic runs, approvals or terminal.
  // Claiming them would make the app offer surfaces that cannot work.
  for (const absent of ['sessions', 'runs', 'approvals', 'terminal']) {
    assert.notEqual(manifest.capabilities[absent], true, `${absent} must not be advertised`);
  }
});
