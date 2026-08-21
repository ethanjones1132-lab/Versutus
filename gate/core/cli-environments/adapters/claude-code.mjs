import { homedir } from 'node:os';
import { join } from 'node:path';

import { probeVersion } from './shared.mjs';
import { createClaudeCodeBackend } from '../backends/claude-code.mjs';

export const claudeCodeAdapter = {
  adapterId: 'claude-code',
  adapterRevision: '1',
  supportedCliVersions: '2.1.x',
  protocolVersions: { jsonl: '1' },
  capabilities: ['chat', 'stream-json', 'mcp', 'sessions', 'tools', 'models'],

  /**
   * Claude Code has no long-lived server: `--print` runs one process per turn
   * and exits, with `--session-id` providing continuity and on-disk transcripts
   * providing history. Nothing to supervise between turns.
   */
  server: { transport: 'per-turn' },

  createBackend({ record, claudeHome = join(homedir(), '.claude') } = {}) {
    return createClaudeCodeBackend({
      executablePath: record.executable.path,
      cwd: record.workspacePolicy?.defaultRoot,
      claudeHome,
    });
  },
  operations: {
    prompt: {
      inputSchema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } },
      risk: 'workspace_write',
      machineReadable: true,
    },
    status: {
      inputSchema: { type: 'object', properties: {} },
      risk: 'read',
      machineReadable: true,
    },
    interactive: {
      inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
      risk: 'credential',
      machineReadable: false,
    },
  },
  async probe(executablePath) {
    return probeVersion(executablePath, {
      min: '2.1.0',
      maxExclusiveMajor: 3,
      protocol: 'jsonl',
      handshakeArgs: ['--output-format', 'stream-json', '--probe'],
    });
  },
  /**
   * Non-interactive argv per operation, read off `claude --help`: `-p` prints
   * the reply for a prompt given as the positional argument, and `--version`
   * is the call probe() already makes. Returns null for an operation that
   * needs a real terminal, so the run fails honestly instead of completing
   * empty.
   */
  runInvocation(operation, input = {}) {
    if (operation === 'status') return { args: ['--version'] };
    if (operation === 'prompt') {
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      if (!prompt) return null;
      return { args: ['-p', prompt] };
    }
    return null;
  },
};
