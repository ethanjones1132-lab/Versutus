import { readdir as defaultReaddir, readFile as defaultReadFile } from 'node:fs/promises';
import { join } from 'node:path';

export function parseListenKey(envText) {
  if (typeof envText !== 'string') return null;
  for (const raw of envText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key !== 'API_SERVER_KEY') continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value || null;
  }
  return null;
}

export function parseDisplayName(yamlText) {
  const match = typeof yamlText === 'string'
    ? /^\s*display_name:\s*(.+)\s*$/m.exec(yamlText)
    : null;
  if (!match) return null;
  let value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value || null;
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
    || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    const inner = value.slice(1, -1);
    // A double-quoted YAML scalar carries backslash escapes; undo the two the
    // bounded writer can emit so a written description reads back verbatim.
    return inner.replace(/\\(["\\])/g, '$1');
  }
  return value;
}

/**
 * Reads a top-level scalar that the CLI may fold across lines, e.g.
 * `description: one\r\n  two.`. Only indented continuation text is folded —
 * the next column-0 key ends the value — and nothing but this field is read.
 */
export function parseDescription(yamlText) {
  if (typeof yamlText !== 'string') return null;
  const lines = yamlText.split(/\r?\n/);
  const start = lines.findIndex((line) => /^description:(?:[ \t]+.*)?$/.test(line));
  if (start === -1) return null;
  const parts = [(lines[start].match(/^description:(?:[ \t]+(.*))?$/)?.[1] ?? '').trim()];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) break;
    if (!/^[ \t]+\S/.test(line)) break;
    parts.push(line.trim());
  }
  const folded = stripQuotes(parts.filter(Boolean).join(' ')).trim();
  return folded || null;
}

/**
 * Extracts ONLY `model.default` / `model.provider` from a profile's
 * config.yaml. The file also carries provider API keys; no other key may be
 * surfaced through a public bot record.
 */
export function parseModelPin(configText) {
  const pin = { default: null, provider: null };
  if (typeof configText !== 'string') return pin;
  const lines = configText.split(/\r?\n/);
  const blockStart = lines.findIndex((line) => /^model:\s*$/.test(line));
  if (blockStart === -1) return pin;
  for (let i = blockStart + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (!/^[ \t]+\S/.test(line)) break;
    for (const field of ['default', 'provider']) {
      const match = new RegExp(`^[ \\t]+${field}:[ \\t]+(.+)$`).exec(line);
      if (match) pin[field] = stripQuotes(match[1].trim()) || null;
    }
  }
  return pin;
}

/** Values Hermes' own `is_truthy_value` accepts for a boolean config flag. */
const TRUTHY = new Set(['true', 'on', 'yes', '1']);

/**
 * Whether the host has `gateway.multiplex_profiles` on — true, false, or null
 * when there is nothing to read.
 *
 * Named-prefix routing (`/p/<name>/`) only exists when this is on. With it
 * off, Hermes ignores the prefix entirely and serves the DEFAULT profile —
 * observed 2026-08-24 on 0.20.4, where `/p/anvil/`, `/p/rook/` and even
 * `/p/doesnotexist/` all returned the default profile's sessions byte for
 * byte. Absent means off, which is Hermes' own default
 * (`bool(cfg_get(cfg, "gateway", "multiplex_profiles", default=False))`);
 * hermes_cli/config.py also accepts the top-level form. Unreadable stays null
 * so no caller blocks on a guess.
 */
export function parseMultiplexEnabled(configText) {
  if (typeof configText !== 'string' || !configText.trim()) return null;
  const lines = configText.split(/\r?\n/);
  const top = lines.find((line) => /^multiplex_profiles:[ \t]*\S/.test(line));
  if (top) return TRUTHY.has(top.split(':')[1].trim().toLowerCase());
  const blockStart = lines.findIndex((line) => /^gateway:[ \t]*$/.test(line));
  if (blockStart !== -1) {
    for (let i = blockStart + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim()) continue;
      if (!/^[ \t]+\S/.test(line)) break;
      const match = /^[ \t]+multiplex_profiles:[ \t]*(\S+)/.exec(line);
      if (match) return TRUTHY.has(match[1].trim().toLowerCase());
    }
  }
  return false;
}

/**
 * Why a listed Bot cannot carry chat traffic right now, or null when it can.
 *  - 'listen_key_missing': the profile .env carries no API_SERVER_KEY.
 *  - 'multiplex_disabled': the host has multiplex off, so `/p/<name>/` is not
 *    an address at all — the blocker to clear before any key change matters.
 *  - 'default_key_refused': the profile still holds the default profile's
 *    listen key — Hermes multiplex rejects that key on every named prefix
 *    (ADR 0005), so promising routing would fail at chat time.
 *
 * `multiplex` only ever *renames* an existing refusal, never creates one: a
 * profile with its own key keeps its verdict whatever the config says,
 * because config alone cannot see Hermes' env override.
 */
export function describeRouting(record, defaultListenKey = null, multiplex = null) {
  if (!record.listenKey) return { routable: false, routingIssue: 'listen_key_missing' };
  if (
    record.id !== 'default'
    && typeof defaultListenKey === 'string'
    && record.listenKey === defaultListenKey
  ) {
    return {
      routable: false,
      routingIssue: multiplex === false ? 'multiplex_disabled' : 'default_key_refused',
    };
  }
  return { routable: true, routingIssue: null };
}

export function toPublicBot(record, defaultListenKey = null, multiplex = null) {
  const model = record.model ?? {};
  const pinned = model.default || model.provider
    ? { default: model.default ?? null, provider: model.provider ?? null }
    : null;
  const { routable, routingIssue } = describeRouting(record, defaultListenKey, multiplex);
  return {
    id: record.id,
    displayName: record.displayName,
    routable,
    routingIssue,
    description: record.description ?? null,
    model: pinned,
  };
}

async function readText(path, readFile) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

async function botAt(id, home, readFile) {
  const envText = await readText(join(home, '.env'), readFile);
  const yamlText = await readText(join(home, 'profile.yaml'), readFile);
  const configText = await readText(join(home, 'config.yaml'), readFile);
  return {
    id,
    displayName: parseDisplayName(yamlText) || id,
    listenKey: parseListenKey(envText),
    description: parseDescription(yamlText),
    model: parseModelPin(configText),
    home,
  };
}

export async function listHermesBots(hermesHome, io = {}) {
  const readFile = io.readFile ?? defaultReadFile;
  const readdir = io.readdir ?? defaultReaddir;
  const bots = [await botAt('default', hermesHome, readFile)];
  let names = [];
  try {
    names = await readdir(join(hermesHome, 'profiles'), { withFileTypes: true });
  } catch {
    return bots;
  }
  for (const entry of names) {
    const name = entry.name ?? entry;
    const isDir = typeof entry.isDirectory === 'function' ? entry.isDirectory() : true;
    if (!isDir || name.startsWith('.')) continue;
    bots.push(await botAt(name, join(hermesHome, 'profiles', name), readFile));
  }
  return bots;
}

export async function getHermesBot(hermesHome, id, io = {}) {
  if (!id) return null;
  if (id === 'default') {
    const readFile = io.readFile ?? defaultReadFile;
    return botAt('default', hermesHome, readFile);
  }
  const bots = await listHermesBots(hermesHome, io);
  return bots.find((bot) => bot.id === id) ?? null;
}
