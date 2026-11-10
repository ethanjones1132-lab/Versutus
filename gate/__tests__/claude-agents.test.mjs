import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { parseAgentFile, scanAgentDirs } from '../core/cli-environments/claude-agents.mjs';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'claude-agents-'));
  roots.push(root);
  return root;
}

/** An agent file's text, with the fields a caller names and nothing else. */
function agentText({ name, description, model, extra = [] } = {}) {
  const lines = ['---'];
  if (name !== undefined) lines.push(`name: ${name}`);
  if (description !== undefined) lines.push(`description: ${description}`);
  if (model !== undefined) lines.push(`model: ${model}`);
  lines.push(...extra, '---', 'Standing instructions.');
  return `${lines.join('\n')}\n`;
}

async function writeAgent(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
  return path;
}

/**
 * Only the rows this test's own tree can explain.
 *
 * The project walk goes from the workspace up to the filesystem root, by
 * design, so a developer machine with real agent files above the temp tree
 * would otherwise leak into the assertions.
 */
function inTree(rows, root, names) {
  return rows.filter((row) => row.path.startsWith(root) && (!names || names.includes(row.name)));
}

// ─── Frontmatter ─────────────────────────────────────────────────────────

test('flat frontmatter is read, quotes stripped, other keys ignored', () => {
  assert.deepEqual(parseAgentFile(agentText({
    name: '"Reviewer"',
    description: "'Reviews diffs before they land.'",
    model: 'opus',
    extra: ['tools: Read, Grep', 'color: blue'],
  })), {
    name: 'Reviewer',
    description: 'Reviews diffs before they land.',
    model: 'opus',
  });
});

test('a list-valued key such as tools never becomes a field', () => {
  const parsed = parseAgentFile([
    '---',
    'name: reviewer',
    'description: Reviews diffs.',
    'tools:',
    '  - Read',
    '  - Grep',
    '---',
  ].join('\n'));
  // `- Read` is not a `key: value` line, so it cannot leak into `name` or
  // overwrite anything. The only model fact here is that none was pinned.
  assert.deepEqual(parsed, { name: 'reviewer', description: 'Reviews diffs.', model: null });
});

test('a file without a description is skipped, as Claude Code skips it', () => {
  assert.equal(parseAgentFile(agentText({ name: 'reviewer' })), null);
  assert.equal(parseAgentFile(agentText({ name: 'reviewer', description: '"  "' })), null);
});

test('a name containing a colon is refused', () => {
  // The colon is the roster's own runtime separator, so a name carrying one
  // could never be addressed back as a Bot.
  assert.equal(parseAgentFile(agentText({ name: 'team:reviewer', description: 'Reviews.' })), null);
});

test('a blank or overlong name is refused', () => {
  assert.equal(parseAgentFile(agentText({ name: '""', description: 'Reviews.' })), null);
  assert.equal(parseAgentFile(agentText({ name: 'x'.repeat(257), description: 'Reviews.' })), null);
  assert.equal(parseAgentFile(agentText({ name: 'x'.repeat(256), description: 'Reviews.' })).name, 'x'.repeat(256));
});

test('body text without frontmatter is not an agent', () => {
  assert.equal(parseAgentFile('# Reviewer\n\nReviews diffs.\n'), null);
  assert.equal(parseAgentFile('name: reviewer\ndescription: Reviews.\n'), null);
  // A closer that never arrives is an unparseable file, not a whole-file read.
  assert.equal(parseAgentFile('---\nname: reviewer\ndescription: Reviews.\n'), null);
  assert.equal(parseAgentFile(''), null);
  assert.equal(parseAgentFile(null), null);
});

// ─── Discovery ───────────────────────────────────────────────────────────

test('agent files are found recursively, project first and user after', async () => {
  const root = await makeRoot();
  const workspace = join(root, 'ws');
  const home = join(root, 'home');
  const projectAgents = join(workspace, '.claude', 'agents');
  const userAgents = join(home, 'agents');

  await writeAgent(join(projectAgents, 'reviewer.md'), agentText({ name: 'reviewer', description: 'Project reviewer.' }));
  await writeAgent(join(projectAgents, 'nested', 'deeper', 'writer.md'), agentText({ name: 'writer', description: 'Nested writer.' }));
  await writeAgent(join(userAgents, 'reviewer.md'), agentText({ name: 'reviewer', description: 'User reviewer.' }));
  await writeAgent(join(userAgents, 'researcher.md'), agentText({ name: 'researcher', description: 'User researcher.' }));

  const rows = await scanAgentDirs({ claudeHome: home, cwd: workspace });
  const mine = inTree(rows, root, ['reviewer', 'writer', 'researcher']);
  const byName = new Map(mine.map((row) => [row.name, row]));

  // A subfolder is scanned, not just the top of the tree.
  assert.equal(byName.get('writer').scope, 'project');
  assert.equal(byName.get('writer').path, join(projectAgents, 'nested', 'deeper', 'writer.md'));

  // Project beats user for the same name.
  assert.equal(mine.filter((row) => row.name === 'reviewer').length, 1);
  assert.equal(byName.get('reviewer').scope, 'project');
  assert.equal(byName.get('reviewer').description, 'Project reviewer.');

  assert.equal(byName.get('researcher').scope, 'user');
  assert.equal(byName.get('researcher').path, join(userAgents, 'researcher.md'));

  // Every project row precedes every user row.
  assert.ok(mine.findIndex((row) => row.name === 'researcher') > mine.findIndex((row) => row.name === 'writer'));
});

test('the closest project directory wins over a further one', async () => {
  const root = await makeRoot();
  const outer = join(root, 'ws');
  const inner = join(outer, 'packages', 'app');
  const home = join(root, 'home');

  const outerFile = await writeAgent(join(outer, '.claude', 'agents', 'reviewer.md'),
    agentText({ name: 'reviewer', description: 'Outer reviewer.' }));
  await writeAgent(join(inner, '.claude', 'agents', 'reviewer.md'),
    agentText({ name: 'reviewer', description: 'Inner reviewer.' }));

  const rows = inTree(await scanAgentDirs({ claudeHome: home, cwd: inner }), root)
    .filter((row) => row.name === 'reviewer');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].description, 'Inner reviewer.');
  assert.notEqual(rows[0].path, outerFile);
});

test('rows inside one scope are ordered by name', async () => {
  const root = await makeRoot();
  const workspace = join(root, 'ws');
  const dir = join(workspace, '.claude', 'agents');
  await writeAgent(join(dir, 'zulu.md'), agentText({ name: 'zulu', description: 'Last.' }));
  await writeAgent(join(dir, 'alpha.md'), agentText({ name: 'alpha', description: 'First.' }));

  const rows = inTree(await scanAgentDirs({ claudeHome: join(root, 'home'), cwd: workspace }), root,
    ['alpha', 'zulu']).map((row) => row.name);
  assert.deepEqual(rows, ['alpha', 'zulu']);
});

test('missing directories are simply nothing to scan', async () => {
  const root = await makeRoot();
  // Nothing exists at either path, and nothing under them may appear either.
  const rows = await scanAgentDirs({
    claudeHome: join(root, 'no-home'),
    cwd: join(root, 'no-workspace'),
  });
  assert.deepEqual(rows.filter((row) => row.path.startsWith(root)), []);
  // And with no home and no workspace there is nothing to look at at all.
  assert.deepEqual(await scanAgentDirs(), []);
  assert.deepEqual(await scanAgentDirs({}), []);
});

test('a file with no name is ignored while its neighbours still list', async () => {
  const root = await makeRoot();
  const workspace = join(root, 'ws');
  const dir = join(workspace, '.claude', 'agents');
  const nameless = await writeAgent(join(dir, 'nameless.md'), agentText({ description: 'Orphan.' }));
  await writeAgent(join(dir, 'not-frontmatter.md'), '# Notes\n\nNo frontmatter here.\n');
  await writeAgent(join(dir, 'reviewer.md'), agentText({ name: 'reviewer', description: 'Reviews.' }));
  await writeAgent(join(dir, 'ignored.txt'), agentText({ name: 'text-file', description: 'Not markdown.' }));

  const rows = await scanAgentDirs({ claudeHome: join(root, 'home'), cwd: workspace });
  assert.ok(rows.some((row) => row.name === 'reviewer'));
  assert.ok(!rows.some((row) => row.path === nameless));
  assert.ok(!rows.some((row) => row.name === 'text-file'));
});
