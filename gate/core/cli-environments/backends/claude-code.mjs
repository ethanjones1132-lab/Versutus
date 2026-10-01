import { spawn as nodeSpawn } from 'node:child_process';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { spawnCommand } from '../adapters/shared.mjs';
import { createWindowsJob } from '../windows-job.mjs';

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

// Listing hundreds of transcripts one at a time is the serial read that made
// /v1/sessions miss its budget; a few in flight keeps the disk busy without
// opening a file descriptor per transcript.
const STAT_CONCURRENCY = 8;
const READ_CONCURRENCY = 4;

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
    const thinking = parts.filter((p) => p.type === 'thinking').map((p) => p.thinking).join('');
    if (thinking) return { type: 'message.reasoning.delta', payload: { text: thinking, sessionId: event.session_id } };
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
    const block = event.event?.content_block;
    if (event.event?.type === 'content_block_start' && block?.type === 'tool_use') {
      return { type: 'tool.started', payload: {
        name: block.name, callId: block.id,
        ...(block.input !== undefined ? { input: block.input } : {}),
      } };
    }
    const delta = event.event?.delta;
    if (delta?.type === 'text_delta' && delta.text) {
      return { type: 'message.delta', payload: { text: delta.text, sessionId: event.session_id } };
    }
    if (delta?.type === 'thinking_delta' && delta.thinking) {
      return { type: 'message.reasoning.delta', payload: { text: delta.thinking, sessionId: event.session_id } };
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
  jobFactory = createWindowsJob,
  permissionMode = 'default',
} = {}) {
  const dir = transcriptDirFor(claudeHome, cwd);

  /**
   * Ids handed out by createSession that no turn has bound yet.
   *
   * Claude Code writes a transcript only when a turn runs, so a just-created
   * session has no file. Without this the id was indistinguishable from one
   * the Gate never issued: listSessions omitted it and listMessages threw
   * "not found", which the route reported as a 500. The app opens a chat the
   * instant it creates one, so *every* new conversation opened onto that
   * error — and because the session never appeared in the list either, the
   * app could not recognise its own and minted another on each reconnect.
   *
   * Reservations are process-local on purpose: they hold no history, so
   * losing them across a Gate restart costs nothing.
   */
  const reserved = new Map();

  /**
   * The turn in flight, so `abort()` has something to stop.
   *
   * A per-turn backend has no pipe to drop and no server to interrupt: the turn
   * *is* the process, so this is the only handle that can end one. Held as a
   * slot rather than a stack because a turn is the only one that can be running.
   */
  let inflight = null;

  /** What a stopped turn rejects with: a cancellation, not a failed run. */
  function stoppedError() {
    const error = new Error('claude-code: turn stopped');
    error.name = 'AbortError';
    error.code = 'aborted';
    return error;
  }

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

    async listSessions(limit = 50) {
      const files = await transcripts();
      // `stat` is cheap; reading a transcript is not. A project grows one file
      // per conversation and nothing prunes them, so the files are ranked on
      // their mtime first and only the rows the caller asked for are opened —
      // parsing all of them serialised is what blew the phone's read budget.
      const infos = await mapConcurrently(files, STAT_CONCURRENCY, (file) =>
        stat(join(dir, file)).catch(() => null));
      const newest = files
        .map((file, index) => ({ file, info: infos[index] }))
        .filter((entry) => entry.info)
        .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)
        .slice(0, limit);
      const previews = await mapConcurrently(newest, READ_CONCURRENCY, async ({ file }) => {
        try {
          const entries = await readTranscript(file.slice(0, -'.jsonl'.length));
          const firstUser = entries.find((e) => e.type === 'user' && e.message);
          return toGatewayMessage(firstUser ?? {}).content[0]?.text?.slice(0, 80) ?? null;
        } catch {
          // an unreadable transcript still lists, just without a preview
          return null;
        }
      });
      const sessions = newest.map(({ file, info }, index) => {
        const id = file.slice(0, -'.jsonl'.length);
        return {
          id,
          source: 'claude-code',
          user_id: null,
          model: null,
          title: previews[index],
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
          preview: previews[index],
          has_system_prompt: false,
          has_model_config: false,
        };
      });
      // Reserved-but-unbound ids belong in the list too: a session the caller
      // just created must be findable, or it cannot tell its own thread from
      // one the Gate never issued.
      const onDisk = new Set(sessions.map((session) => session.id));
      for (const [id, record] of reserved) {
        if (!onDisk.has(id)) sessions.push(record);
      }
      return sessions.sort((a, b) => b.last_active - a.last_active);
    },

    /**
     * A session exists once a turn has written its transcript, so this only
     * reserves an id — the same id `--session-id` will bind on first use.
     */
    async createSession({ title } = {}) {
      const id = randomUUID();
      const record = {
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
      reserved.set(id, record);
      return record;
    },

    async deleteSession(sessionId) {
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('invalid session id');
      reserved.delete(sessionId);
      await rm(join(dir, `${sessionId}.jsonl`), { force: true });
    },

    async listMessages(sessionId, limit) {
      // A reserved id with no transcript is an empty conversation, not a
      // missing one — answering [] is what lets a brand-new chat open.
      if (reserved.has(sessionId) && !(await transcripts()).includes(`${sessionId}.jsonl`)) return [];
      const entries = await readTranscript(sessionId);
      const mapped = entries
        .filter((entry) => entry.message && (entry.type === 'user' || entry.type === 'assistant'))
        .map(toGatewayMessage)
        .filter((message) => message.content.length > 0 || message.tool_calls);
      return typeof limit === 'number' ? mapped.slice(-limit) : mapped;
    },

    /** One process per turn; `--session-id` is what makes it a conversation. */
    async sendMessage(sessionId, { text, model, signal } = {}, onEvent) {
      const args = [
        '--print',
        '--output-format', 'stream-json',
        '--include-partial-messages',
        '--verbose',
        '--permission-mode', permissionMode,
        '--session-id', sessionId,
      ];
      const chosen = model?.modelId ?? defaultModel;
      if (chosen) args.push('--model', chosen);
      args.push(text ?? '');

      const { command, prefix } = spawnCommand(executablePath);
      const child = spawnImpl(command, [...prefix, ...args], { cwd, windowsHide: true });
      // A job per turn, not per backend: a stop must take the tools this turn
      // spawned with it, and must never reach a pid an earlier turn registered.
      const job = jobFactory();
      job.add(child);
      const turn = { cancelled: false };
      inflight = turn;
      /**
       * Kill the tree, then reject — in that order. Stop is a promise to the
       * operator that the agent stops working in the workspace, so a rejection
       * that outran the kill would be a lie.
       */
      const cancel = (reject) => {
        if (turn.cancelled) return;
        turn.cancelled = true;
        Promise.resolve()
          .then(() => job.terminate())
          .catch(() => undefined)
          .then(() => reject(stoppedError()));
      };

      let buffer = '';
      let assembled = '';
      let failure = null;
      let sawPartialText = false;
      let sawPartialThinking = false;
      const partialToolIds = new Set();
      const partialToolBlocks = new Map();
      const handle = (line) => {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        // Claude repeats every partial block in its complete `assistant`
        // message. Emit the complete message only for blocks whose partials
        // never arrived, so neither the transcript nor a tool card doubles.
        if (parsed.type === 'assistant' && Array.isArray(parsed.message?.content)) {
          for (const part of parsed.message.content) {
            let event = null;
            if (part.type === 'text' && part.text && !sawPartialText) {
              event = { type: 'message.delta', payload: { text: part.text, sessionId: parsed.session_id } };
            } else if (part.type === 'thinking' && part.thinking && !sawPartialThinking) {
              event = { type: 'message.reasoning.delta', payload: { text: part.thinking, sessionId: parsed.session_id } };
            } else if (part.type === 'tool_use' && part.name && !partialToolIds.has(part.id)) {
              event = { type: 'tool.started', payload: { name: part.name, callId: part.id, input: part.input } };
            }
            if (event?.type === 'message.delta') assembled += event.payload.text;
            if (event) onEvent?.(event);
          }
          sawPartialText = false;
          sawPartialThinking = false;
          partialToolIds.clear();
          return;
        }
        if (parsed.type === 'stream_event') {
          const streamEvent = parsed.event ?? {};
          const index = streamEvent.index;
          if (streamEvent.type === 'content_block_delta'
            && streamEvent.delta?.type === 'input_json_delta'
            && Number.isInteger(index)) {
            const block = partialToolBlocks.get(index);
            if (block && typeof streamEvent.delta.partial_json === 'string') {
              block.partialJson = `${block.partialJson}${streamEvent.delta.partial_json}`.slice(0, 2048);
            }
            return;
          }
          if (streamEvent.type === 'content_block_stop' && Number.isInteger(index)) {
            const block = partialToolBlocks.get(index);
            if (block?.partialJson) {
              onEvent?.({ type: 'tool.progress', payload: {
                name: block.name,
                callId: block.callId,
                detail: block.partialJson,
                snapshot: true,
              } });
            }
            partialToolBlocks.delete(index);
            return;
          }
        }
        const normalized = normalizeClaudeEvent(parsed);
        if (!normalized) return;
        if (parsed.type === 'stream_event') {
          if (normalized.type === 'message.delta') sawPartialText = true;
          else if (normalized.type === 'message.reasoning.delta') sawPartialThinking = true;
          else if (normalized.type === 'tool.started' && normalized.payload.callId) {
            partialToolIds.add(normalized.payload.callId);
            const index = parsed.event?.index;
            if (Number.isInteger(index)) {
              partialToolBlocks.set(index, {
                callId: normalized.payload.callId,
                name: normalized.payload.name,
                partialJson: '',
              });
            }
          }
        }
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

      let onAbort = null;
      let exitCode;
      try {
        exitCode = await new Promise((resolve, reject) => {
          // A cancelled turn settles as a cancellation however its child dies:
          // the exit code of a process that was killed is not the turn's
          // outcome, and neither is a stdin error on the way down.
          child.on('error', (error) => { if (!turn.cancelled) reject(error); });
          child.on('close', (code) => { if (!turn.cancelled) resolve(code); });
          // `signal` is how the runner hands the turn's cancellation down: the
          // runner's own race settles the HTTP turn, but only this kills the
          // agent still reading the workspace and calling the vendor.
          if (signal) {
            onAbort = () => cancel(reject);
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }
          turn.cancel = () => cancel(reject);
        });
      } finally {
        // A turn that ended on its own leaves nothing on the caller's signal:
        // hundreds of turns would otherwise stack listeners on it, and a late
        // abort would try to kill a process that already exited.
        if (onAbort) signal.removeEventListener('abort', onAbort);
        if (inflight === turn) inflight = null;
      }
      if (buffer.trim()) handle(buffer.trim());

      if (failure) throw new Error(`claude-code: ${failure}`);
      if (exitCode !== 0 && !assembled) throw new Error(`claude-code exited with code ${exitCode}`);
      return {
        message: assembled ? { id: sessionId, role: 'assistant', content: [{ type: 'text', text: assembled }] } : null,
        text: assembled,
      };
    },

    /**
     * Stop the turn in flight. A per-turn backend has nothing to drop but the
     * process, so this terminates it; between turns there is nothing to stop.
     */
    async abort() {
      await inflight?.cancel?.();
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

/** `Promise.all` over a long list, with at most `limit` in flight. */
async function mapConcurrently(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
