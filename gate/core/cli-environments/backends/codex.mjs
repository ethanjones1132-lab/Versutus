/**
 * Codex as a chat backend.
 *
 * Codex speaks newline-delimited JSON-RPC over stdio (`codex app-server`) and
 * models a conversation as a **thread** containing **turns**. It owns its own
 * threads, model list, tools and approvals; the Gate proxies to them.
 *
 * Approvals arrive as server→client *requests* rather than notifications, so
 * they must be answered or the agent blocks — see jsonrpc-stdio.mjs.
 */

const APPROVAL_METHODS = new Set([
  'execCommandApproval',
  'applyPatchApproval',
  'commandExecutionRequestApproval',
  'fileChangeRequestApproval',
  'permissionsRequestApproval',
]);

/** Translate a Codex thread into the shape the app already parses. */
export function toGatewaySession(thread) {
  return {
    id: thread.id ?? thread.threadId,
    source: 'codex',
    user_id: null,
    model: thread.model ?? null,
    title: thread.name ?? thread.title ?? null,
    started_at: toMillis(thread.createdAt ?? thread.created_at),
    ended_at: null,
    end_reason: null,
    message_count: thread.turnCount ?? 0,
    tool_call_count: 0,
    input_tokens: thread.tokenUsage?.input ?? 0,
    output_tokens: thread.tokenUsage?.output ?? 0,
    cache_read_tokens: thread.tokenUsage?.cachedInput ?? 0,
    cache_write_tokens: 0,
    reasoning_tokens: thread.tokenUsage?.reasoning ?? 0,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    api_call_count: 0,
    parent_session_id: thread.parentThreadId ?? null,
    last_active: toMillis(thread.updatedAt ?? thread.createdAt),
    preview: thread.preview ?? thread.name ?? null,
    has_system_prompt: false,
    has_model_config: Boolean(thread.model),
  };
}

function toMillis(value) {
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

/** Turn items into the app's message shape. */
export function toGatewayMessage(item) {
  const text = typeof item.text === 'string'
    ? item.text
    : (item.content ?? []).map((part) => part?.text ?? '').join('');
  return {
    id: item.id,
    role: item.role ?? (item.type === 'userMessage' ? 'user' : 'assistant'),
    content: text ? [{ type: 'text', text }] : [],
    timestamp: toMillis(item.createdAt),
  };
}

/**
 * Map a Codex notification onto the normalized vocabulary in
 * docs/cli-environment-interface-v1.md.
 */
export function normalizeCodexEvent(message) {
  const method = message?.method;
  if (!method) return null;
  const params = message.params ?? {};

  switch (method) {
    case 'item/agentMessage/delta':
      return { type: 'message.delta', payload: { text: params.delta ?? '', threadId: params.threadId } };
    case 'item/reasoning/summaryTextDelta':
      return { type: 'message.reasoning.delta', payload: { text: params.delta ?? '', threadId: params.threadId } };
    case 'item/started':
      if (!isToolItem(params.item)) break;
      return { type: 'tool.started', payload: {
        name: toolName(params.item), callId: params.item?.id,
        ...(params.item?.command ? { input: params.item.command }
          : params.item?.arguments !== undefined ? { input: params.item.arguments } : {}),
      } };
    case 'item/completed':
      if (!isToolItem(params.item)) break;
      return { type: 'tool.output', payload: {
        name: toolName(params.item), callId: params.item?.id,
        status: params.item?.status,
        isError: ['failed', 'declined'].includes(params.item?.status)
          || Boolean(params.item?.error),
        output: params.item?.aggregatedOutput ?? params.item?.error?.message,
      } };
    case 'item/commandExecution/outputDelta':
    case 'command/exec/outputDelta':
    case 'process/outputDelta':
      return { type: 'tool.progress', payload: {
        name: 'exec', callId: params.itemId, text: decodeChunk(params.chunk ?? params.delta),
      } };
    case 'item/mcpToolCall/progress':
      return { type: 'tool.progress', payload: {
        name: 'mcpToolCall', callId: params.itemId, text: params.message ?? '',
      } };
    case 'turn/completed':
      return { type: 'run.completed', payload: { threadId: params.threadId, turnId: params.turnId } };
    case 'error':
      return { type: 'run.failed', payload: { error: params.message ?? params.error } };
    case 'thread/tokenUsage/updated':
      return { type: 'usage', payload: { tokens: params.tokenUsage ?? params.usage } };
    default:
      break;
  }
  return { type: 'diagnostic', payload: { source: method, params } };
}

function isToolItem(item) {
  const type = item?.type ?? '';
  return /command|exec|patch|fileChange|mcpToolCall|tool/i.test(type);
}

function toolName(item) {
  return item?.tool ?? item?.name ?? item?.type ?? 'tool';
}

function decodeChunk(chunk) {
  if (typeof chunk === 'string') return chunk;
  if (Array.isArray(chunk)) return Buffer.from(chunk).toString('utf8');
  return '';
}

/** Is this a server request asking us to approve something? */
export function isApprovalRequest(method) {
  return APPROVAL_METHODS.has(method);
}

/**
 * How long a turn the app-server has already accepted is given to finish.
 *
 * A turn this old that has neither failed nor completed is not going to: the
 * text collected so far is a fragment, and reporting it as the answer tells the
 * operator the model is done while it is still working. Injectable so a test
 * proves the failure without waiting one out.
 */
const TURN_TIMEOUT_MS = 180_000;

/**
 * Build a backend over a connected app-server.
 *
 * `cwd` is the environment's workspace root: Codex scopes a thread to a
 * directory, so this is what keeps a run inside the configured workspace.
 */
export function createCodexBackend({ rpc, cwd, onApproval, subscribe, turnTimeoutMs = TURN_TIMEOUT_MS } = {}) {
  const threadTurns = new Map();

  /** What a stopped turn rejects with: a cancellation, not a failed run. */
  function stoppedTurn() {
    const error = new Error('codex: turn stopped');
    error.name = 'AbortError';
    error.code = 'aborted';
    return error;
  }

  /**
   * `turn/start` returns as soon as the turn is accepted; the reply text arrives
   * as notifications. Callers that want a complete answer (non-streaming chat)
   * need the turn awaited, so collect deltas until the terminal event.
   *
   * Three ways out, all of which release the subscription: the terminal event,
   * the turn's own bound, and the caller's signal — without which a Stop ended
   * the phone's turn and left the app-server working into a bus nobody was
   * reading for the rest of these three minutes.
   */
  function awaitTurn(threadId, { timeoutMs = TURN_TIMEOUT_MS, signal } = {}) {
    if (!subscribe) return Promise.resolve({ text: '', completed: false });
    return new Promise((resolve) => {
      let text = '';
      const release = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        unsubscribe?.();
      };
      const finish = (extra = {}) => {
        release();
        resolve({ text, completed: true, ...extra });
      };
      const onAbort = () => {
        release();
        resolve({ text, completed: false, aborted: true });
      };
      const timer = setTimeout(() => {
        unsubscribe?.();
        resolve({ text, completed: false });
      }, timeoutMs);
      timer.unref?.();
      const unsubscribe = subscribe((message) => {
        if (message?.params?.threadId && message.params.threadId !== threadId) return;
        const event = normalizeCodexEvent(message);
        if (event?.type === 'message.delta') text += event.payload.text ?? '';
        else if (event?.type === 'run.completed') finish();
        else if (event?.type === 'run.failed') finish({ error: event.payload.error });
      });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Stop the app-server's turn; nothing else in the Gate ever interrupts one. */
  async function interruptTurn(threadId, turnId) {
    await rpc.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
  }

  function scopedHandler(sessionId, onEvent) {
    return (message) => {
      const threadId = message?.params?.threadId;
      if (sessionId && threadId && threadId !== sessionId) return;
      const normalized = normalizeCodexEvent(message);
      if (normalized) onEvent(normalized);
    };
  }

  return {
    kind: 'codex',

    async listSessions(limit = 50) {
      const result = await rpc.request('thread/list', { limit, cwd });
      return unwrap(result, 'threads').map(toGatewaySession);
    },

    async createSession({ title } = {}) {
      const result = await rpc.request('thread/start', { cwd });
      const threadId = result?.threadId ?? result?.thread?.id ?? result?.id;
      if (title && threadId) {
        await rpc.request('thread/name/set', { threadId, name: title }).catch(() => undefined);
      }
      return toGatewaySession({ ...(result?.thread ?? {}), id: threadId, name: title });
    },

    async deleteSession(sessionId) {
      await rpc.request('thread/delete', { threadId: sessionId });
    },

    async listMessages(sessionId, limit) {
      const result = await rpc.request('thread/read', { threadId: sessionId, includeTurns: true });
      const items = collectItems(result);
      const mapped = items.map(toGatewayMessage).filter((m) => m.content.length > 0);
      return typeof limit === 'number' ? mapped.slice(-limit) : mapped;
    },

    async sendMessage(sessionId, { text, model, signal } = {}) {
      const params = {
        threadId: sessionId,
        cwd,
        input: [{ type: 'text', text }],
      };
      if (model?.modelId) {
        params.model = model.modelId;
      } else {
        // The CLI's configured default can be unavailable to this account.
        // Pick from its live catalog when the caller left the model unset.
        try {
          const catalog = unwrap(await rpc.request('model/list', { limit: 200 }), 'models');
          const available = catalog.filter((entry) => !entry.hidden);
          const chosen = available.find((entry) => entry.isDefault) ?? available[0];
          if (chosen) params.model = chosen.id ?? chosen.model;
        } catch { /* preserve the CLI's own default when the catalog is unavailable */ }
      }
      // Subscribe before starting: the first deltas can land before turn/start
      // has even returned.
      const settled = awaitTurn(sessionId, { timeoutMs: turnTimeoutMs, signal });
      const result = await rpc.request('turn/start', params);
      if (result?.turnId) threadTurns.set(sessionId, result.turnId);
      const outcome = await settled;
      if (outcome.aborted) {
        // Stop ends the phone's turn; the app-server's turn has to end with it,
        // or it keeps working into a stream nobody is reading.
        await interruptTurn(sessionId, result?.turnId ?? threadTurns.get(sessionId));
        throw stoppedTurn();
      }
      if (outcome.error) {
        throw new Error(typeof outcome.error === 'string' ? outcome.error : JSON.stringify(outcome.error));
      }
      if (!outcome.completed) {
        // The turn never reached `turn/completed`, so the text so far is a
        // fragment of a turn the app-server is still running. Publishing it
        // with `finish_reason: stop` would tell the operator the model is done
        // while it is still working — and the model-health table would score the
        // silence as a success. Stop the turn and say what happened.
        await interruptTurn(sessionId, result?.turnId ?? threadTurns.get(sessionId));
        const seconds = Math.max(1, Math.round(turnTimeoutMs / 1000));
        throw new Error(
          `codex: the turn did not answer within ${seconds}s and was stopped — ` +
          'ask again, or try a model that is not still working',
        );
      }
      const reply = outcome.text || result?.text || '';
      return {
        message: reply
          ? { id: result?.turnId, role: 'assistant', content: [{ type: 'text', text: reply }] }
          : null,
        text: reply,
        turnId: result?.turnId,
      };
    },

    async abort(sessionId) {
      await interruptTurn(sessionId, threadTurns.get(sessionId));
    },

    async replyApproval(_sessionId, requestId, reply) {
      onApproval?.(requestId, reply);
    },

    async listModels() {
      const result = await rpc.request('model/list', { limit: 200 });
      return unwrap(result, 'models').map((model) => ({
        id: model.id ?? model.slug ?? model.name,
        providerId: model.provider ?? 'codex',
        modelId: model.id ?? model.slug ?? model.name,
        label: model.displayName ?? model.name ?? model.id,
        available: true,
      }));
    },

    /** Notifications are registered synchronously before the turn starts. */
    streamEvents(sessionId, onEvent, signal) {
      if (!subscribe) return Promise.resolve();
      return new Promise((resolve) => {
        const handler = scopedHandler(sessionId, onEvent);
        const unsubscribe = subscribe(handler);
        const finish = () => {
          signal?.removeEventListener('abort', finish);
          unsubscribe();
          resolve();
        };
        if (signal?.aborted) finish();
        else signal?.addEventListener('abort', finish, { once: true });
      });
    },

    /**
     * Codex pushes notifications for every thread on one connection, so filter
     * by thread the way OpenCode's shared bus is filtered by session.
     */
    subscribe(sessionId, onEvent) {
      return scopedHandler(sessionId, onEvent);
    },
  };
}

/**
 * Codex paginates under `data`. Accept the named key and a bare array too, so a
 * shape change upstream degrades to empty rather than throwing.
 */
function unwrap(result, namedKey) {
  if (Array.isArray(result)) return result;
  const candidate = result?.data ?? result?.[namedKey] ?? result?.items;
  return Array.isArray(candidate) ? candidate : [];
}

function collectItems(result) {
  if (Array.isArray(result?.items)) return result.items;
  const turns = result?.turns ?? result?.thread?.turns ?? [];
  return turns.flatMap((turn) => turn.items ?? []);
}
