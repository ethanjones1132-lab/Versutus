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
    return value.slice(1, -1);
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

export function toPublicBot(record) {
  const model = record.model ?? {};
  const pinned = model.default || model.provider
    ? { default: model.default ?? null, provider: model.provider ?? null }
    : null;
  return {
    id: record.id,
    displayName: record.displayName,
    routable: Boolean(record.listenKey),
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
