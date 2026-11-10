/**
 * Claude Code agent files as Bots (ADR 0016).
 *
 * An agent is a markdown file under an `agents/` directory: YAML frontmatter
 * naming it, describing when to use it and optionally pinning a model. Claude
 * Code owns those files — the Gate only reads them, from the same two places
 * the CLI discovers them: `<cwd>/.claude/agents` walking up to the filesystem
 * root, then `~/.claude/agents`. Nothing is written and nothing outside those
 * directories is read.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** A one-line scalar, quoted or bare, with the quotes removed. */
function unquote(value) {
  if (value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1).trim();
  }
  return value;
}

/**
 * One agent file, or null for a file Claude Code itself would skip.
 *
 * The frontmatter is read as flat `key: value` lines on purpose: a full YAML
 * parse would drag in a dependency for six fields, and the only fields the
 * roster needs are scalars. Every other key — including list-valued ones like
 * `tools` — is ignored, so a richer file still lists.
 */
export function parseAgentFile(text) {
  if (typeof text !== 'string') return null;
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (close === -1) return null;

  const fields = {};
  for (const line of lines.slice(1, close)) {
    const match = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    if (key !== 'name' && key !== 'description' && key !== 'model') continue;
    if (key in fields) continue;
    fields[key] = unquote(match[2].trim());
  }

  const name = (fields.name ?? '').trim();
  // A name is what `--agent` is given and what the roster keys on, so the same
  // files Claude Code refuses are refused here: no name, an absurdly long one,
  // or a colon (which is the Gate's own runtime separator).
  if (!name || name.length > 256 || name.includes(':')) return null;
  const description = (fields.description ?? '').trim();
  if (!description) return null;
  return { name, description, model: fields.model?.trim() || null };
}

/** Every markdown file under `dir`, recursively. A missing or unreadable directory is empty. */
async function markdownFilesIn(dir, found = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    // Only real directories are descended into: a symlinked directory would
    // point outside the agents tree, and that tree is the whole contract.
    if (entry.isDirectory()) await markdownFilesIn(path, found);
    else if (entry.isFile() && entry.name.endsWith('.md')) found.push(path);
  }
  return found;
}

/** The `agents` directories to search, in the order Claude Code looks at them. */
function agentDirs({ claudeHome, cwd }) {
  const dirs = [];
  if (typeof cwd === 'string' && cwd.trim()) {
    let dir = resolve(cwd);
    for (;;) {
      dirs.push({ dir: join(dir, '.claude', 'agents'), scope: 'project' });
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  if (typeof claudeHome === 'string' && claudeHome.trim()) {
    dirs.push({ dir: join(claudeHome, 'agents'), scope: 'user' });
  }
  return dirs;
}

/**
 * The agent files on this computer, project first.
 *
 * A project definition beats the user one of the same name, and the closest
 * project directory beats a further one — the opposite of how a shell resolves
 * PATH, because the more specific the workspace the more it should say. A file
 * that cannot be read or parsed is skipped rather than failing the roster: one
 * malformed agent must not hide every other Bot.
 */
export async function scanAgentDirs({ claudeHome, cwd } = {}) {
  const found = [];
  const seen = new Set();
  const visited = new Set();
  for (const { dir, scope } of agentDirs({ claudeHome, cwd })) {
    if (visited.has(dir)) continue;
    visited.add(dir);
    const rows = [];
    for (const path of await markdownFilesIn(dir)) {
      const text = await readFile(path, 'utf8').catch(() => null);
      if (text === null) continue;
      const agent = parseAgentFile(text);
      if (agent) rows.push({ ...agent, path, scope });
    }
    // Within one scope the first file by name — and by path, for two files
    // defining one agent — is the tie-break, so the same scan always picks the
    // same row.
    rows.sort((a, b) => (a.name === b.name
      ? (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
      : (a.name < b.name ? -1 : 1)));
    for (const row of rows) {
      if (seen.has(row.name)) continue;
      seen.add(row.name);
      found.push(row);
    }
  }
  return found;
}
