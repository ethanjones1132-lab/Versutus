import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createConptyFallback } from '../core/cli-environments/conpty.mjs';

test('unstructured output cannot mutate provider or approval state', async () => {
  const providerService = { calls: [] };
  const approvalService = { pending: [] };
  const fallback = createConptyFallback({
    providerService,
    approvalService,
    desktopPresent: true,
  });
  await fallback.acceptChunk('Model: invented\nApprove? yes');
  assert.equal(providerService.calls.length, 0);
  assert.equal(approvalService.pending.length, 0);
});

test('requires desktop presence and only treats exit code as a machine result', async () => {
  const fallback = createConptyFallback({ desktopPresent: false });
  await assert.rejects(() => fallback.start({ operation: 'login' }), /desktop/i);
  const local = createConptyFallback({ desktopPresent: true });
  const session = await local.start({ operation: 'login' });
  await session.acceptChunk('\x1b[31mhello\x1b[0m');
  const result = await session.exit(3);
  assert.equal(result.exitCode, 3);
  assert.equal(result.success, undefined);
  assert.ok(!session.chunks.join('').includes('\x1b['));
});

test('adapters mark interactive-only operations as not machine-readable', async () => {
  const { hermesAdapter } = await import('../core/cli-environments/adapters/hermes.mjs');
  const { codexAdapter } = await import('../core/cli-environments/adapters/codex.mjs');
  const { claudeCodeAdapter } = await import('../core/cli-environments/adapters/claude-code.mjs');
  const { opencodeAdapter } = await import('../core/cli-environments/adapters/opencode.mjs');
  for (const adapter of [hermesAdapter, codexAdapter, claudeCodeAdapter, opencodeAdapter]) {
    assert.equal(adapter.operations.interactive.machineReadable, false);
    assert.equal(adapter.operations.interactive.risk, 'credential');
  }
});
