import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const gateDir = join(__dirname, '..');
const cliPath = join(gateDir, 'cli.mjs');

/**
 * Test helper: run a CLI command and capture stdout/stderr. Resolves the
 * CLI script and its cwd relative to this test file, not process.cwd(),
 * so this file behaves identically whether the suite is invoked from the
 * repo root or from gate/ (matching this project's other test files).
 */
async function runCli(args) {
  return new Promise((resolve) => {
    const proc = spawn('node', [cliPath, ...args], {
      cwd: gateDir,
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
  await assert.rejects(
    access(join(gateDir, 'registry', 'test-instance.json')),
    /ENOENT/,
    'instance file should not exist',
  );
});

test('path traversal with --kind "." is rejected at validation', async () => {
  const result = await runCli(['add', 'test-instance', '--kind', '.']);

  assert.equal(result.code, 1, 'command should exit with code 1');
  assert.match(result.stderr, /kind id must be lowercase alphanumeric with hyphens/, 'should reject with validation error');
});

test('kind module that throws at import time is reported distinctly from "not found"', async () => {
  const mockKindPath = join(gateDir, 'core', 'capabilities', 'broken-kind-test');

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
    await assert.rejects(
      access(join(gateDir, 'registry', 'test-instance.json')),
      /ENOENT/,
      'instance file should not exist',
    );
  } finally {
    // Clean up the broken kind
    await rm(mockKindPath, { recursive: true, force: true }).catch(() => {});
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
