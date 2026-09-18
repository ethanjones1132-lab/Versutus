// ─── Whether Codex realtime can run on this host ──────────────────────────
// M1 S1 (2026-09-13, codex-cli 0.147.0): `thread/realtime/start` with
// `features.realtime_conversation=true` and `capabilities.experimentalApi`
// still answers `realtime conversation requires API key auth` on a ChatGPT
// login. listVoices works; the conversation never starts. This module only
// names that fact for `voice.capabilities`. It does not spawn Codex.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CODEX_CHATGPT_BLOCK =
  'Codex realtime needs an API key; the ChatGPT login does not provide one.';

export const CODEX_ENGINE_UNWIRED =
  'Codex realtime is not wired in this Gate yet, even with an API key.';

/** Read `auth_mode` from Codex's auth file. Never returns the rest of the file. */
export function readCodexAuthMode({
  env = process.env,
  home = homedir(),
  readFile = readFileSync,
} = {}) {
  const root = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.length > 0
    ? env.CODEX_HOME
    : join(home, '.codex');
  try {
    const parsed = JSON.parse(readFile(join(root, 'auth.json'), 'utf8'));
    return typeof parsed?.auth_mode === 'string' ? parsed.auth_mode : null;
  } catch {
    return null;
  }
}

/**
 * What `voice.capabilities` reports for the Codex engine.
 *
 * ChatGPT login: unavailable (S1). API key: still unavailable until a Gate
 * engine exists. A kill-switch is the caller's job (`disabled`).
 */
export function codexRealtimeStatus(authMode) {
  if (authMode === 'api_key') {
    return { state: 'unavailable', reason: CODEX_ENGINE_UNWIRED };
  }
  return { state: 'unavailable', reason: CODEX_CHATGPT_BLOCK };
}
