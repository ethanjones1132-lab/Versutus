import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CODEX_CHATGPT_BLOCK,
  CODEX_ENGINE_UNWIRED,
  codexRealtimeStatus,
  readCodexAuthMode,
} from '../core/voice/codex-status.mjs';

test('a ChatGPT login cannot run Codex realtime', () => {
  const status = codexRealtimeStatus('chatgpt');
  assert.equal(status.state, 'unavailable');
  assert.equal(status.reason, CODEX_CHATGPT_BLOCK);
});

test('an API-key login is still unavailable until a Gate engine exists', () => {
  const status = codexRealtimeStatus('api_key');
  assert.equal(status.state, 'unavailable');
  assert.equal(status.reason, CODEX_ENGINE_UNWIRED);
  assert.notEqual(status.state, 'ready');
});

test('a missing or unknown login is treated as the ChatGPT block, not ready', () => {
  assert.equal(codexRealtimeStatus(null).state, 'unavailable');
  assert.equal(codexRealtimeStatus('other').reason, CODEX_CHATGPT_BLOCK);
});

test('readCodexAuthMode returns only the mode, and null when the file is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-status-'));
  mkdirSync(join(dir, 'codex-home'), { recursive: true });
  writeFileSync(
    join(dir, 'codex-home', 'auth.json'),
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { access: 'secret-must-not-leak' } }),
  );
  assert.equal(
    readCodexAuthMode({ env: { CODEX_HOME: join(dir, 'codex-home') } }),
    'chatgpt',
  );
  assert.equal(readCodexAuthMode({ env: { CODEX_HOME: join(dir, 'missing') } }), null);
});
