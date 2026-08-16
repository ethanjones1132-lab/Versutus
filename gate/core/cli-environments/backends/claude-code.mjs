import { spawn as nodeSpawn } from 'node:child_process';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { spawnCommand } from '../adapters/shared.mjs';

/**
 * Claude Code as a chat backend.
 *
 * Unlike OpenCode (HTTP server) and Codex (persistent stdio JSON-RPC), Claude
 * Code runs **one process per turn**: `--print --output-format stream-json`
 * emits newline-delimited events and exits. Continuity comes from `--session-id`,
 * and history lives in on-disk transcripts rather than behind an API — so
 * listing sessions means reading the project's transcript directory.
 */

/** Claude Code names a project directory after its cwd, with separators flattened. */
export function transcriptDirFor(claudeHome, cwd) {
  return join(claudeHome, 'projects', String(cwd).replace(/[:\\/.]/g, '-'));
}

/** Map a transcript entry onto the app's message shape. */
export function toGatewayMessage(entry) {
  const message = entry.message ?? {};
  const parts = Array.isArray(message.content)
    ? message.content
    : [{ type: 'text', text: String(message.content ?? '') }];
  const content = parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string' && part.text)
    .map((part) => ({ type: 'text', text: part.text }));
  const toolCalls = parts
    .filter((part) => part.type === 'tool_use')
    .map((part) => ({ name: part.name, id: part.id, status: 'complete' }));
  return {
    id: entry.uuid,
    role: message.role ?? entry.type,
    content,
    timestamp: Date.parse(entry.timestamp ?? '') || undefined,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

/**
 * Map a stream-json event onto the normalized vocabulary. Claude Code emits
 * whole assistant messages rather than token deltas unless
 * `--include-partial-messages` is set, so a text block becomes one delta.
 */
export function normalizeClaudeEvent(event) {
  if (!event?.type) return null;

  if (event.type === 'assistant') {
    const parts = event.message?.content ?? [];
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
    const tool = parts.find((p) => p.type === 'tool_use');
    if (tool) return { type: 'tool.started', payload: { name: tool.name, callId: tool.id, input: tool.input } };
    if (text) return { type: 'message.delta', payload: { text, sessionId: event.session_id } };
    return { type: 'diagnostic', payload: { source: 'assistant', parts: parts.map((p) => p.type) } };
  }

  if (event.type === 'user') {
    const parts = event.message?.content ?? [];
    const result = parts.find((p) => p.type === 'tool_result');
    if (result) {
      return { type: 'tool.output', payload: { callId: result.tool_use_id, isError: Boolean(result.is_error) } };
    }
    return { type: 'diagnostic', payload: { source: 'user' } };
  }

  if (event.type === 'stream_event') {
    const delta = event.event?.delta;
    if (delta?.type === 'text_delta' && delta.text) {
      return { type: 'message.delta', payload: { text: delta.text, sessionId: event.session_id } };
    }
    return { type: 'diagnostic', payload: { source: 'stream_event' } };
  }

  if (event.type === 'result') {
    // `subtype: 'success'` still carries auth and tool failures in `result`.
    const failed = event.is_error || /^(Failed to authenticate|API Error)/i.test(String(event.result ?? ''));
    return {
      type: failed ? 'run.failed' : 'run.completed',
      payload: {
        sessionId: event.session_id,
        text: event.result,
        costUsd: event.total_cost_usd,
        turns: event.num_turns,
      },
    };
  }

  return { type: 'diagnostic', payload: { source: `${event.type}${event.subtype ? `/${event.subtype}` : ''}` } };
}

export function createClaudeCodeBackend({
  executablePath,
  cwd,
  claudeHome,
  model: defaultModel,
  spawnImpl = nodeSpawn,
  permissionMode = 'default',
} = {}) {
  const dir = transcriptDirFor(claudeHome, cwd);

  async function transcripts() {
    try {
      const names = await readdir(dir);
      return names.filter((name) => name.endsWith('.jsonl'));
    } catch {
      return [];
    }
  }

  async function readTranscript(sessionId) {
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('invalid session id');
    const raw = await readFile(join(dir, `${sessionId}.jsonl`), 'utf8').catch(() => null);
    if (raw === null) throw new Error(`session "${sessionId}" not found`);
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  }

  return {
    kind: 'claude-code',

    async listSessions() {
      const files = await transcripts();
      const sessions = [];
      for (const file of files) {
        const id = file.slice(0, -'.jsonl'.length);
        const info = await stat(join(dir, file)).catch(() => null);
        if (!info) continue;
        let preview = null;
        try {
          const entries = await readTranscript(id);
          const firstUser = entries.find((e) => e.type === 'user' && e.message);
          preview = toGatewayMessage(firstUser ?? {}).content[0]?.text?.slice(0, 80) ?? null;
        } catch {
          // an unreadable transcript still lists, just without a preview
        }
        sessions.push({
          id,
          source: 'claude-code',
          user_id: null,
          model: null,
          title: preview,
          started_at: info.birthtimeMs || info.mtimeMs,
          ended_at: null,
          end_reason: null,
          message_count: 0,
          tool_call_count: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          estimated_cost_usd: null,
          actual_cost_usd: null,
          api_call_count: 0,
          parent_session_id: null,
          last_active: info.mtimeMs,
          preview,
          has_system_prompt: false,
          has_model_config: false,
        });
      }
      return sessions.sort((a, b) => b.last_active - a.last_active);
    },

    /**
     * A session exists once a turn has written its transcript, so this only
     * reserves an id — the same id `--session-id` will bind on first use.
     */
    async createSession({ title } = {}) {
      const id = randomUUID();
      return {
        id,
        source: 'claude-code',
        user_id: null,
        model: null,
        title: title ?? null,
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
        message_count: 0,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        estimated_cost_usd: null,
        actual_cost_usd: null,
        api_call_count: 0,
        parent_session_id: null,
        last_active: Date.now(),
        preview: null,
        has_system_prompt: false,
        has_model_config: false,
      };
    },

    async deleteSession(sessionId) {
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('invalid session id');
      await rm(join(dir, `${sessionId}.jsonl`), { force: true });
    },

    async listMessages(sessionId, limit) {
      const entries = await readTranscript(sessionId);
      const mapped = entries
        .filter((entry) => entry.message && (entry.type === 'user' || entry.type === 'assistant'))
        .map(toGatewayMessage)
        .filter((message) => message.content.length > 0 || message.tool_calls);
      return typeof limit === 'number' ? mapped.slice(-limit) : mapped;
    },

    /** One process per turn; `--session-id` is what makes it a conversation. */
    async sendMessage(sessionId, { text, model } = {}, onEvent) {
      const args = [
        '--print',
        '--output-format', 'stream-json',
        '--verbose',
        '--permission-mode', permissionMode,
        '--session-id', sessionId,
      ];
      const chosen = model?.modelId ?? defaultModel;
      if (chosen) args.push('--model', chosen);
      args.push(text ?? '');

      const { command, prefix } = spawnCommand(executablePath);
      const child = spawnImpl(command, [...prefix, ...args], { cwd, windowsHide: true });

      let buffer = '';
      let assembled = '';
      let failure = null;
      const handle = (line) => {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        const normalized = normalizeClaudeEvent(parsed);
        if (!normalized) return;
        if (normalized.type === 'message.delta') assembled += normalized.payload.text;
        if (normalized.type === 'run.failed') failure = normalized.payload.text ?? 'run failed';
        if (normalized.type === 'run.completed' && !assembled) assembled = normalized.payload.text ?? '';
        onEvent?.(normalized);
      };

      child.stdout?.on('data', (chunk) => {
        buffer += String(chunk);
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) handle(line.trim());
      });

      const exitCode = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
      });
      if (buffer.trim()) handle(buffer.trim());

      if (failure) throw new Error(`claude-code: ${failure}`);
      if (exitCode !== 0 && !assembled) throw new Error(`claude-code exited with code ${exitCode}`);
      return {
        message: assembled ? { id: sessionId, role: 'assistant', content: [{ type: 'text', text: assembled }] } : null,
        text: assembled,
      };
    },

    async abort() {
      // A turn is a process; cancellation is handled by the job that owns it.
    },

    async replyApproval() {
      throw new Error('claude-code approvals are answered in its own permission prompt');
    },

    /**
     * Claude Code exposes no model list. These are the aliases `--model`
     * documents; a full model name may also be passed through.
     */
    async listModels() {
      return ['opus', 'sonnet', 'haiku'].map((alias) => ({
        id: alias,
        providerId: 'anthropic',
        modelId: alias,
        label: `Claude ${alias[0].toUpperCase()}${alias.slice(1)}`,
        available: true,
      }));
    },
  };
}
