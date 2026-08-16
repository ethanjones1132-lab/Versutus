import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCliEnvironment } from '../core/cli-environments/process-environment.mjs';
import { assertCliProviderBinding } from '../core/providers/service.mjs';

const request = {
  environmentId: 'hermes-local',
  runId: 'run-1',
  providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
  audience: 'versutus-gate',
  endpoints: { chat: 'http://127.0.0.1:8760/v1/chat/completions' },
};

test('child environment excludes inherited provider secrets', () => {
  const child = buildCliEnvironment({ PATH: 'x', OPENAI_API_KEY: 'secret' }, request);
  assert.equal(child.OPENAI_API_KEY, undefined);
  assert.ok(child.VERSUTUS_CLI_INVOCATION_TOKEN);
  assert.equal(child.PATH, 'x');
  assert.equal(child.ANTHROPIC_API_KEY, undefined);
  assert.equal(child.XAI_API_KEY, undefined);
});

test('CLI-native sessions require a local_interface provider', () => {
  assert.throws(
    () => assertCliProviderBinding({ mode: 'api_key' }, { consumeGateProxy: false }),
    /provider_cli_binding_unsupported/,
  );
  assert.doesNotThrow(() => assertCliProviderBinding(
    { mode: 'local_interface', auth: { credentialCustodian: 'external' } },
    { consumeGateProxy: false },
  ));
  assert.doesNotThrow(() => assertCliProviderBinding({ mode: 'api_key' }, { consumeGateProxy: true }));
});
