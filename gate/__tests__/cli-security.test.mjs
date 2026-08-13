import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Test helper: run a CLI command and capture stdout/stderr
 */
async function runCli(args) {
  return new Promise((resolve) => {
    const proc = spawn('node', ['gate/cli.mjs', ...args], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

test('path traversal attack with --kind "../evil" is rejected at validation', async () => {
  // Attempt path traversal: ../../../evil-kind-test should be rejected by validateId
  // before any import() is attempted
  const result = await runCli(['add', 'test-instance', '--kind', '../../../evil-kind-test']);

  assert.equal(result.code, 1, 'command should exit with code 1');
  assert.match(result.stderr, /kind id must be lowercase alphanumeric with hyphens/, 'should reject with validation error');
  assert.match(result.stderr, /\.\./, 'error message should show the attempted path traversal');

  // Verify no instance file was created
  const { promises: fs } = await import('node:fs');
  try {
    await fs.access('gate/registry/test-instance.json');
    throw new Error('instance file should not have been created');
  } catch (err) {
    assert.match(err.message, /ENOENT|instance file should not/, 'instance file should not exist');
  }
});

test('path traversal with --kind "." is rejected at validation', async () => {
  const result = await runCli(['add', 'test-instance', '--kind', '.']);

  assert.equal(result.code, 1, 'command should exit with code 1');
  assert.match(result.stderr, /kind id must be lowercase alphanumeric with hyphens/, 'should reject with validation error');
});

test('kind module that throws at import time is reported distinctly from "not found"', async () => {
  // Create a temporary broken kind module
  const tmpDir = await mkdtemp(join(tmpdir(), 'cli-security-broken-kind-'));
  const kindDir = join(tmpDir, '..', 'gate', 'core', 'capabilities', 'broken-kind-test');

  // Set up a temporary directory to mock the kind
  const mockKindPath = join(process.cwd(), 'gate', 'core', 'capabilities', 'broken-kind-test');

  try {
    // Create the broken kind directory
    await mkdir(mockKindPath, { recursive: true });

    // Write a kind.mjs that throws at import time
    await writeFile(
      join(mockKindPath, 'kind.mjs'),
      `throw new Error('Intentional import-time error for testing');`,
      'utf-8'
    );

    // Try to add an instance of this broken kind
    const result = await runCli(['add', 'test-instance', '--kind', 'broken-kind-test']);

    assert.equal(result.code, 1, 'command should exit with code 1');
    // The error message should mention the load failure, NOT just "not found"
    assert.match(result.stderr, /failed to load/, 'should indicate the kind failed to load');
    assert.match(result.stderr, /Intentional import-time error/, 'should show the actual error message');

    // Verify no instance file was created
    try {
      await import('node:fs/promises').then((fs) => fs.access('gate/registry/test-instance.json'));
      throw new Error('instance file should not have been created');
    } catch (err) {
      assert.match(err.message, /ENOENT|instance file should not/, 'instance file should not exist');
    }
  } finally {
    // Clean up the broken kind
    try {
      await rm(mockKindPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
});

test('normal kind load error for truly nonexistent kind', async () => {
  const result = await runCli(['add', 'test-instance', '--kind', 'definitely-not-a-real-kind']);

  assert.equal(result.code, 1, 'command should exit with code 1');
  // Should indicate not found or load failure
  assert.match(
    result.stderr,
    /not found|failed to load|ENOENT/i,
    'should mention either not found or load failure'
  );
});
