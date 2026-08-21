import { randomBytes } from 'node:crypto';

import { parseListenKey } from './hermes-profiles.mjs';

export function validateBotId(name) {
  const id = typeof name === 'string' ? name.trim() : '';
  if (!id || id.toLowerCase() === 'default') return null;
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(id)) return null;
  return id;
}

export function createBotArgs({ name, inheritKeys, description } = {}) {
  const id = validateBotId(name);
  if (!id) throw new Error('invalid bot name');
  const args = ['profile', 'create', id, '--no-alias'];
  if (inheritKeys) args.push('--clone-from', 'default');
  if (description) args.push('--description', String(description));
  return args;
}

export function ensureDistinctListenKey(envText, defaultKey) {
  const existing = parseListenKey(envText);
  if (existing && existing !== defaultKey) {
    return { envText: envText ?? '', listenKey: existing };
  }
  const listenKey = randomBytes(32).toString('hex');
  const lines = String(envText ?? '').split(/\r?\n/);
  let replaced = false;
  const next = lines.map((line) => {
    if (!/^\s*API_SERVER_KEY\s*=/.test(line)) return line;
    replaced = true;
    return `API_SERVER_KEY=${listenKey}`;
  });
  if (!replaced) {
    if (next.length === 1 && next[0] === '') next.pop();
    next.push(`API_SERVER_KEY=${listenKey}`);
  }
  return { envText: next.join('\n').replace(/\n*$/, '\n'), listenKey };
}
