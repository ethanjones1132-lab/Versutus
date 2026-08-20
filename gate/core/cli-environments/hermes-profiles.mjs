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

export function toPublicBot(record) {
  return {
    id: record.id,
    displayName: record.displayName,
    routable: Boolean(record.listenKey),
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
  return {
    id,
    displayName: parseDisplayName(yamlText) || id,
    listenKey: parseListenKey(envText),
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
