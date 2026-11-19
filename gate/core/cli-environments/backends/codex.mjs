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

import { createThreadQueue } from '../../voice/handoff.mjs';

const APPROVAL_METHODS = new Set([
  'execCommandApproval',
  'applyPatchApproval',
  'commandExecutionRequestApproval',
  'fileChangeRequestApproval',
  'permissionsRequestApproval',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
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
 * How long a turn the app-server has already accepted may stay *silent*.
 *
 * Silence is measured from the last sign of life, never from `turn/start`: a
 * turn that is still streaming deltas, streaming tool output or waiting on a
 * tool is working, and reporting its fragment as the answer tells the operator
 * the model is done while it is still working. Only a turn that has said
 * nothing for this long is treated as one that is not going to answer.
 * Injectable so a test proves the failure without waiting one out.
 */
const TURN_TIMEOUT_MS = 180_000;

/** An item the app-server opened without an id (nothing else to key it on). */
const ANONYMOUS_ITEM = '#item';

/**
 * The one Bot this environment serves: the agent itself (ADR 0016).
 *
 * A Bot is routable when the backend that lists it can answer, and only a
 * healthy backend ever reaches `listBots`, so this row is always routable.
 * `runtime` is what lets the roster tell two agents apart, exactly as the
 * OpenCode rows do.
 */
const CODEX_BOT = {
  id: 'codex',
  displayName: 'Codex',
  routable: true,
  routingIssue: null,
  description: "OpenAI's coding agent on this computer",
  model: null,
  runtime: 'codex',
};

/** The refusal every Bot lookup shares: this environment has never heard of that id. */
function unknownBot(id) {
  const error = new Error(`unknown bot "${id}"`);
  error.code = 'unknown_bot';
  error.status = 404;
  return error;
}

/**
 * Build a backend over a connected app-server.
 *
 * `cwd` is the environment's workspace root: Codex scopes a thread to a
 * directory, so this is what keeps a run inside the configured workspace.
 */
export function createCodexBackend({ rpc, cwd, onApproval, subscribe, registerVoiceThread, turnTimeoutMs = TURN_TIMEOUT_MS } = {}) {
  const threadTurns = new Map();
  // Ordinary sends share the thread as before. An inject or a voice turn
  // needs exclusive access: native approvals are scoped by thread, so a
  // voice registration must not overlap an ordinary send on that thread.
  // Track the adapter, not the relay, which can stop before the interrupt.
  const nativeWrites = createThreadQueue();
  const trackSend = (send) => (sessionId, options) => {
    if (options?.source !== 'voice') {
      return nativeWrites.runShared(sessionId, () => send(sessionId, options));
    }
    return nativeWrites.run(sessionId, async () => {
      await nativeWrites.drain(sessionId);
      return send(sessionId, options);
    });
  };
  const resuming = new Map();

  function resumeThread(threadId) {
    if (!threadId) return Promise.resolve();
    if (resuming.has(threadId)) return resuming.get(threadId);
    const pending = Promise.resolve().then(() => rpc.request('thread/resume', { threadId, excludeTurns: true })).then((resumed) => {
      if (resumed?.thread?.id !== threadId) throw new Error('Codex did not resume the original thread.');
    }).finally(() => resuming.delete(threadId));
    resuming.set(threadId, pending);
    return pending;
  }

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
   * Terminal events, the idle bound, caller cancellation, and a failed start
   * all release the subscription. Stop must not leave the app-server working
   * into a bus nobody is reading for the rest of these three minutes.
   *
   * The bound is an *idle* bound. Activity for this turn (or its thread as
   * a whole) is a sign of life and restarts it — a turn past three minutes
   * that is still streaming deltas, tool output or token usage is working, and
   * treating it as silent published a fragment as the answer. A tool item the
   * app-server has opened and not finished (`item/started` … `item/completed`)
   * suspends the bound altogether: it is either executing or parked on an
   * approval the operator has not ruled on yet, and the app-server sends
   * nothing while it waits for that ruling. The approval wait therefore never
   * spends the turn's budget; the budget starts again when the item closes.
   */
  function watchTurn(threadId, { timeoutMs = TURN_TIMEOUT_MS, signal, requireSuccess } = {}) {
    if (!subscribe) return { settled: Promise.resolve({ text: '', completed: false }) };
    let identify;
    let close;
    const settled = new Promise((resolve) => {
      let text = '';
      let turnId;
      let early = [];
      // Open tool items by call id. Empty means the turn is not demonstrably
      // working, so the idle bound is what decides whether it still is.
      const openItems = new Set();
      let timer = null;
      let released = false;
      let unsubscribe;
      const release = () => {
        if (released) return;
        released = true;
        early = null;
        clearTimeout(timer);
        timer = null;
        signal?.removeEventListener('abort', onAbort);
        unsubscribe?.();
      };
      const finish = (extra = {}) => {
        release();
        resolve({ text, completed: true, ...extra });
      };
      const expire = () => {
        release();
        resolve({ text, completed: false });
      };
      close = expire;
      // Arm the idle bound from now — unless a tool is open, which is work in
      // progress whatever the clock says. `unref` keeps an idle bound from
      // holding the process open on its own.
      const arm = () => {
        if (released) return;
        clearTimeout(timer);
        timer = null;
        if (openItems.size > 0) return;
        timer = setTimeout(expire, timeoutMs);
        timer.unref?.();
      };
      const onAbort = () => {
        release();
        resolve({ text, completed: false, aborted: true });
      };
      const handleMessage = (message) => {
        if (released) return;
        if (message?.params?.threadId && message.params.threadId !== threadId) return;
        if (message?.method === 'versutus/approval') return; // Gate only, not upstream turn activity
        const eventTurnId = message?.params?.turnId ?? message?.params?.turn?.id;
        // The bus is live before turn/start returns. Replay tagged events once
        // we can tell this turn from a concurrent send on the same thread.
        if (early && (eventTurnId || early.length)) {
          early.push(message);
          return;
        }
        if (turnId && eventTurnId && eventTurnId !== turnId) return;
        const event = normalizeCodexEvent(message);
        if (event?.type === 'message.delta') text += event.payload.text ?? '';
        else if (event?.type === 'run.completed') {
          const status = message.params?.turn?.status;
          finish(requireSuccess && status && status !== 'completed'
            ? { error: 'Codex did not complete the turn.' } : {});
          return;
        }
        else if (event?.type === 'run.failed') { finish({ error: event.payload.error }); return; }
        // Track the approval window: an item opened and not closed covers both
        // an executing command and a command waiting on the operator's ruling.
        const itemId = event?.payload?.callId;
        if (event?.type === 'tool.started') openItems.add(itemId ?? ANONYMOUS_ITEM);
        else if (event?.type === 'tool.output') openItems.delete(itemId ?? ANONYMOUS_ITEM);
        arm();
      };
      identify = (id) => {
        turnId = id;
        const buffered = early;
        early = null;
        for (const message of buffered ?? []) handleMessage(message);
      };
      unsubscribe = subscribe(handleMessage);
      if (released) unsubscribe?.();
      else if (signal?.aborted) onAbort();
      else { signal?.addEventListener('abort', onAbort, { once: true }); arm(); }
    });
    return { settled, identify, close };
  }

  /** Stop the app-server's turn; nothing else in the Gate ever interrupts one. */
  async function interruptTurn(threadId, turnId) {
    await rpc.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
  }

  function scopedHandler(sessionId, onEvent, { voice = false } = {}) {
    return (message) => {
      const threadId = message?.params?.threadId;
      if (sessionId && threadId && threadId !== sessionId) return;
      if (message?.method === 'versutus/approval') {
        if (voice && threadId === sessionId) onEvent({ type: 'approval.required', payload: message.params });
        return;
      }
      const normalized = normalizeCodexEvent(message);
      if (normalized) onEvent(normalized);
    };
  }

  const backend = {
    kind: 'codex',
    // Preload while the call opens, without changing any thread settings.
    // A fresh app-server doesn't have conversations that predate its pipe.
    ensureSession: resumeThread,

    appendVoiceExchange(threadId, { user, assistant }) {
      // https://learn.chatgpt.com/docs/app-server#inject-items-into-a-thread
      // Wire shape (including assistant output_text):
      // https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/suite/v2/thread_inject_items.rs
      // Raw Responses messages only. This call neither runs a turn nor changes
      // its settings. If the original is unloaded, fall back rather than
      // resuming it from voice (resume can initialize the regular MCP servers).
      return nativeWrites.run(threadId, async () => {
        await nativeWrites.drain(threadId);
        const result = await rpc.request('thread/inject_items', {
          threadId,
          items: [
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: user }] },
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: assistant }] },
          ],
        }, { timeoutMs: 3_000 });
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          throw new Error('Codex did not acknowledge the voice append.');
        }
        return true;
      });
    },

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
      return typeof limit === 'number' ? (limit === 0 ? [] : mapped.slice(-limit)) : mapped;
    },

    sendMessage: trackSend(async (sessionId, { text, model, signal, source, includesHandoff, voiceDeviceId, voiceGate } = {}) => {
      const voice = source === 'voice';
      if (voice) {
        signal?.throwIfAborted();
        await resuming.get(sessionId)?.catch(() => {});
        signal?.throwIfAborted();
      }
      if (includesHandoff) {
        const current = await rpc.request('thread/read', { threadId: sessionId });
        if (current?.thread?.status?.type === 'notLoaded') {
          signal?.throwIfAborted();
          await resumeThread(sessionId);
        }
        signal?.throwIfAborted();
      }
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
      // Plain sends preserve start-then-interrupt even if Stop already arrived.
      if (voice || includesHandoff) signal?.throwIfAborted();
      // Subscribe before starting: the first deltas can land before turn/start
      // has even returned.
      const { settled, identify, close } = watchTurn(sessionId, {
        timeoutMs: turnTimeoutMs, signal, requireSuccess: voice || includesHandoff,
      });
      let release;
      try {
        if (voice) {
          release = registerVoiceThread?.(sessionId, {
            deviceId: voiceDeviceId, botId: voiceGate?.botId, sessionId, signal,
            timeoutMs: voiceGate?.timeoutMs,
          });
        }
        let result;
        try {
          result = await rpc.request('turn/start', params);
        } catch (error) {
          // Resume only after an explicit pre-admission missing-thread response.
          // A timeout or lost response could already have committed the input.
          if (!voice || (error?.rpcCode ?? error?.code) !== -32600
            || !/^(thread not found|thread .* (not found|is not loaded))\b/i.test(error.message)) throw error;
          signal?.throwIfAborted();
          await resumeThread(sessionId);
          signal?.throwIfAborted();
          result = await rpc.request('turn/start', params);
        }
        const turnId = result?.turnId ?? result?.turn?.id;
        if (turnId) threadTurns.set(sessionId, turnId);
        identify?.(turnId);
        const outcome = await settled;
        if (outcome.aborted) {
          await interruptTurn(sessionId, turnId ?? threadTurns.get(sessionId));
          throw stoppedTurn();
        }
        if (outcome.error) {
          throw new Error(typeof outcome.error === 'string' ? outcome.error : JSON.stringify(outcome.error));
        }
        if (!outcome.completed) {
          // A silent stream fragment is not a completed answer.
          await interruptTurn(sessionId, turnId ?? threadTurns.get(sessionId));
          const seconds = Math.max(1, Math.round(turnTimeoutMs / 1000));
          throw new Error(
            `codex: the turn did not answer within ${seconds}s and was stopped — ` +
            'ask again, or try a model that is not still working',
          );
        }
        const reply = outcome.text || result?.text || '';
        return {
          message: reply
            ? { id: turnId, role: 'assistant', content: [{ type: 'text', text: reply }] }
            : null,
          text: reply,
          turnId,
        };
      } finally {
        close?.();
        release?.();
      }
    }),

    async abort(sessionId) {
      await interruptTurn(sessionId, threadTurns.get(sessionId));
    },

    async replyApproval(runId, { approved, feedback } = {}) {
      if (typeof onApproval !== 'function') {
        throw new Error('codex: no approval handler is connected');
      }
      return onApproval(runId, { approved: approved === true, feedback });
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
    streamEvents(sessionId, onEvent, signal, options) {
      if (!subscribe) return Promise.resolve();
      return new Promise((resolve) => {
        const handler = scopedHandler(sessionId, onEvent, options);
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

    streamVoiceEvents(sessionId, onEvent, signal) {
      return backend.streamEvents(sessionId, onEvent, signal, { voice: true });
    },

    /**
     * Codex pushes notifications for every thread on one connection, so filter
     * by thread the way OpenCode's shared bus is filtered by session.
     */
    subscribe(sessionId, onEvent) {
      return scopedHandler(sessionId, onEvent);
    },

    // ---- Bots: the agent itself (ADR 0016) ------------------------------
    // Codex profiles are a later slice, so this environment serves exactly one
    // Bot — the agent — and every thread it opens belongs to it. createBot and
    // updateBot stay absent so the Gate refuses them by name instead of
    // pretending there is a roster to edit.

    async listBots() {
      return { object: 'list', data: [{ ...CODEX_BOT }] };
    },

    /**
     * One Bot: the agent, plus the `soul` field every Gate Bot read carries.
     * There is no soul the Gate can read or edit — the CLI's own configuration
     * and profiles are its instructions — so it is explicitly null ("genuinely
     * none") rather than absent, which the app would report as a failed read.
     */
    async getBot({ id } = {}) {
      if (id !== CODEX_BOT.id) throw unknownBot(id);
      return { ...CODEX_BOT, soul: null };
    },

    /** The same backend, labelled with its one Bot; all threads are already its. */
    async forBot(botId) {
      if (botId !== CODEX_BOT.id) throw unknownBot(botId);
      return { ...backend, bot: botId };
    },
  };

  return backend;
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
