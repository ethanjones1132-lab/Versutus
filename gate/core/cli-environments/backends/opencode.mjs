/**
 * OpenCode as a chat backend.
 *
 * OpenCode owns its own sessions, model catalog, tools and approvals; the Gate
 * proxies to them rather than reimplementing any of it. Shapes here are the ones
 * verified live against 1.18.18 — see docs/opencode-backend-contract.md.
 */

/** Translate an OpenCode session into the shape the app already parses. */
export function toGatewaySession(session) {
  const tokens = session.tokens ?? {};
  return {
    id: session.id,
    source: 'opencode',
    user_id: null,
    model: session.model?.modelID ?? null,
    title: session.title ?? null,
    started_at: session.time?.created ?? Date.now(),
    ended_at: null,
    end_reason: null,
    message_count: session.message_count ?? 0,
    tool_call_count: 0,
    input_tokens: tokens.input ?? 0,
    output_tokens: tokens.output ?? 0,
    cache_read_tokens: tokens.cache?.read ?? 0,
    cache_write_tokens: tokens.cache?.write ?? 0,
    reasoning_tokens: tokens.reasoning ?? 0,
    estimated_cost_usd: typeof session.cost === 'number' ? session.cost : null,
    actual_cost_usd: null,
    api_call_count: 0,
    parent_session_id: session.parentID ?? null,
    last_active: session.time?.updated ?? session.time?.created ?? Date.now(),
    preview: session.title ?? null,
    has_system_prompt: false,
    has_model_config: Boolean(session.model),
  };
}

/**
 * Flatten an OpenCode message. Text parts become the `{type,text}[]` content the
 * app's extractMessageText already understands; tool parts are surfaced rather
 * than dropped, since they are the whole point of a native environment.
 */
export function toGatewayMessage(message) {
  const info = message.info ?? {};
  const parts = message.parts ?? [];
  const content = parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => ({ type: 'text', text: part.text }));
  const toolCalls = parts
    .filter((part) => part.type === 'tool')
    .map((part) => ({ name: part.tool, status: mapToolStatus(part.state?.status), id: part.callID }));

  return {
    id: info.id,
    role: info.role ?? 'assistant',
    content,
    timestamp: info.time?.created,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function mapToolStatus(status) {
  if (status === 'completed') return 'complete';
  if (status === 'error' || status === 'failed') return 'error';
  return 'running';
}

function sessionToken(value) {
  return typeof value === 'string' && value ? value : null;
}

/**
 * The bus is global, so a subscription must know an event is its own *before*
 * the event can touch a part cache, a pending-delta queue, the tool call map
 * or the client — not merely before it is emitted.
 *
 * OpenCode does not name the session in one place: a real
 * `message.part.updated` can carry it only on `properties.part.sessionID`,
 * with no `properties.sessionID` at all, and a real `message.updated` carries
 * it only on `properties.info.sessionID`. Reading the outer field alone lets
 * another session's part reuse this one's part id and poison the reasoning /
 * text / snapshot state, emitting its text, its tool progress and its errors as
 * this session's answer — and lets a foreign message's token accounting reach
 * this session as usage with no identity attached at all.
 *
 * So every identifier is honoured: an event that names this session nowhere,
 * or names it under `part.sessionID` or `info.sessionID` only, is adopted (the
 * missing identifiers are filled with this session's own id, which is what the
 * envelope then truly is, so a usage frame reports the session it was billed
 * to); an event naming any other session under any of the three fields is
 * refused; and an event whose identifiers disagree is refused rather than
 * guessed at. An event that names no session at all is left untouched, so the
 * legacy shapes the app already maps keep flowing.
 */
function scopeToSession(event, sessionId) {
  if (!sessionId) return event;
  const props = event?.properties;
  if (!props || typeof props !== 'object') return event;
  const part = props.part && typeof props.part === 'object' ? props.part : null;
  const info = props.info && typeof props.info === 'object' ? props.info : null;
  const outer = sessionToken(props.sessionID);
  const nested = sessionToken(part?.sessionID);
  const fromInfo = sessionToken(info?.sessionID);
  // A session named anywhere else is a foreign event, and identifiers that
  // disagree cannot all be this session, so neither reading is safe to guess.
  if (outer && outer !== sessionId) return null;
  if (nested && nested !== sessionId) return null;
  if (fromInfo && fromInfo !== sessionId) return null;
  if (!outer && !nested && !fromInfo) return event;
  if (outer === sessionId && (!part || nested === sessionId) && (!info || fromInfo === sessionId)) return event;
  const properties = { ...props, sessionID: sessionId };
  if (part && !nested) properties.part = { ...part, sessionID: sessionId };
  if (info && !fromInfo) properties.info = { ...info, sessionID: sessionId };
  return { ...event, properties };
}

const TERMINAL_TOOL_STATES = new Set(['completed', 'error', 'failed']);
const TOOL_PROGRESS_MIN_INTERVAL_MS = 120;
/** A recovered part-type lookup is bounded; the terminal event waits at most this. */
const METADATA_LOOKUP_TIMEOUT_MS = 1000;
/** Abort must settle even if an underlying read/cancel ignores its signal. */
const STREAM_CLEANUP_TIMEOUT_MS = 250;
const ABORTED = Symbol('aborted');

/** Part types whose body streams through `message.part.delta`. */
const STREAMED_PART_TYPES = new Set(['text', 'reasoning']);

function toolInputKey(input) {
  try {
    return (JSON.stringify(input) ?? String(input)).slice(0, 2048);
  } catch {
    return String(input).slice(0, 2048);
  }
}

/** A tool failure carries its cause in `state.error`, not `state.output`. */
function errorText(error) {
  if (error === undefined || error === null) return '';
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    if (typeof error.message === 'string' && error.message) return error.message;
    if (typeof error.name === 'string' && error.name) return error.name;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/**
 * Tracks which streamed part each `message.part.delta` belongs to, and how much
 * of that part has already reached the client.
 *
 * On 1.18.18 a text and a reasoning part both stream their body as
 * `message.part.delta` with `field:'text'` — the only difference is
 * `part.type`, announced separately on `message.part.updated`. The delta names
 * just `partID`, so without this map a thought's delta is indistinguishable
 * from the answer's. The closing `message.part.updated` also carries the full
 * text as a snapshot, which must not be replayed on top of the deltas.
 */
export function createOpenCodePartTracker() {
  const types = new Map();
  const emitted = new Map();
  return {
    partType(partId) {
      return partId ? types.get(partId) : undefined;
    },
    remember(part) {
      if (part?.id && STREAMED_PART_TYPES.has(part.type)) types.set(part.id, part.type);
    },
    noteDelta(partId, text) {
      if (!partId || !text) return;
      emitted.set(partId, (emitted.get(partId) ?? '') + text);
    },
    clear() {
      types.clear();
      emitted.clear();
    },
    snapshot(part) {
      if (!part?.id || !STREAMED_PART_TYPES.has(part.type)) return null;
      const text = typeof part.text === 'string' ? part.text : '';
      const prior = emitted.get(part.id) ?? '';
      let delta = '';
      if (text.startsWith(prior)) delta = text.slice(prior.length);
      else if (!prior) delta = text;
      // A snapshot that only restates what the deltas already sent is a
      // replay: emit nothing rather than duplicate the answer or thought.
      if (!delta) return null;
      emitted.set(part.id, prior + delta);
      return frame(part.type === 'reasoning' ? 'message.reasoning.delta' : 'message.delta', {
        sessionId: part.sessionID,
        text: delta,
        messageId: part.messageID,
        partId: part.id,
      });
    },
  };
}

/**
 * Map an OpenCode bus event onto the normalized vocabulary in
 * docs/cli-environment-interface-v1.md. Anything unrecognised becomes a
 * diagnostic — never silently dropped, so a new upstream event is visible
 * rather than invisible.
 *
 * Pass the `createOpenCodePartTracker()` result as `tracker` so a
 * `field:'text'` delta is routed by the type of the part it names — reasoning
 * to `message.reasoning.delta`, answer text to `message.delta`.
 */
export function normalizeOpenCodeEvent(event, tracker) {
  if (!event?.type) return null;
  const props = event.properties ?? {};
  const sessionId = props.sessionID;

  switch (event.type) {
    case 'message.part.delta': {
      if (typeof props.delta !== 'string') break;
      const partType = tracker?.partType?.(props.partID);
      const reasoning = partType === 'reasoning'
        || props.field === 'reasoning'
        || props.field === 'reasoning_content'
        || props.field === 'thinking';
      if (reasoning) {
        tracker?.noteDelta?.(props.partID, props.delta);
        return frame('message.reasoning.delta', {
          sessionId, text: props.delta, messageId: props.messageID, partId: props.partID,
        });
      }
      if (props.field === 'text') {
        tracker?.noteDelta?.(props.partID, props.delta);
        return frame('message.delta', {
          sessionId, text: props.delta, messageId: props.messageID, partId: props.partID,
        });
      }
      break;
    }
    case 'message.part.updated': {
      const part = props.part;
      if (part && STREAMED_PART_TYPES.has(part.type)) {
        // Names which stream a later delta belongs to; its own text is a
        // snapshot of what the deltas already carry, so only the un-emitted
        // tail is forwarded and the final snapshot is never replayed.
        tracker?.remember?.(part);
        return tracker?.snapshot?.(part) ?? null;
      }
      if (part?.type !== 'tool') break;
      const status = part.state?.status;
      const base = {
        sessionId,
        name: part.tool,
        callId: part.callID,
      };
      if (TERMINAL_TOOL_STATES.has(status)) {
        // A failed tool carries no `output`; its cause lives in `state.error`.
        const output = part.state?.output ?? part.state?.raw
          ?? (status === 'error' || status === 'failed' ? errorText(part.state?.error) : undefined);
        return frame('tool.output', { ...base, status, output });
      }
      const input = part.state?.input;
      const hasInput = input !== undefined
        && (input === null || typeof input !== 'object' || Object.keys(input).length > 0);
      if (status === 'running') {
        // OpenCode sends the parsed arguments as a snapshot on each part
        // update. The runner replaces detail for snapshots and suppresses
        // identical updates, so partial arguments stay useful without
        // appending duplicate JSON or flooding the client.
        return hasInput ? frame('tool.progress', { ...base, input, snapshot: true }) : null;
      }
      return frame('tool.started', { ...base, ...(hasInput ? { input } : {}) });
    }
    case 'message.updated': {
      const tokens = props.info?.tokens;
      if (!tokens) break;
      return frame('usage', { sessionId, tokens, cost: props.info?.cost });
    }
    case 'session.idle':
      return frame('run.completed', { sessionId });
    case 'session.error':
      return frame('run.failed', { sessionId, error: props.error });
    case 'permission.asked':
    case 'permission.v2.asked':
      return frame('approval.required', {
        sessionId,
        approvalId: props.id,
        action: props.action ?? props.permission,
        resources: props.resources ?? props.patterns,
      });
    default:
      break;
  }
  return frame('diagnostic', { sessionId, source: event.type, properties: props });
}

function frame(type, payload) {
  return { type, payload };
}

/** Build a backend bound to a running OpenCode server. */
export function createOpenCodeBackend({ baseUrl, fetchImpl = fetch, password } = {}) {
  const root = String(baseUrl).replace(/\/+$/, '');

  async function call(path, init = {}) {
    const headers = { ...(init.headers ?? {}) };
    if (init.body) headers['Content-Type'] = 'application/json';
    if (password) headers.Authorization = `Bearer ${password}`;
    const response = await fetchImpl(`${root}${path}`, { ...init, headers }).catch((err) => {
      const cause = err?.cause?.message ?? err?.message ?? String(err);
      throw new Error(`opencode: could not reach ${root}${path} (${cause})`);
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let message = text || `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text);
        message = parsed?.data?.message ?? parsed?.message ?? parsed?.name ?? message;
      } catch {
        // keep the raw text
      }
      throw new Error(`opencode: ${message}`);
    }
    return response.json();
  }

  return {
    kind: 'opencode',

    async listSessions() {
      const sessions = await call('/session');
      return (Array.isArray(sessions) ? sessions : []).map(toGatewaySession);
    },

    async createSession({ title, model } = {}) {
      const body = {};
      if (title) body.title = title;
      if (model?.providerId) body.model = { providerID: model.providerId, id: model.modelId };
      return toGatewaySession(await call('/session', { method: 'POST', body: JSON.stringify(body) }));
    },

    async deleteSession(sessionId) {
      await call(`/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    },

    async listMessages(sessionId, limit) {
      const messages = await call(`/session/${encodeURIComponent(sessionId)}/message`);
      const mapped = (Array.isArray(messages) ? messages : []).map(toGatewayMessage);
      return typeof limit === 'number' ? mapped.slice(-limit) : mapped;
    },

    /** Blocks until the turn completes; live deltas come from streamEvents. */
    async sendMessage(sessionId, { text, model } = {}) {
      const body = { parts: [{ type: 'text', text }] };
      if (model?.providerId) body.model = { providerID: model.providerId, modelID: model.modelId };
      const message = await call(`/session/${encodeURIComponent(sessionId)}/message`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      // OpenCode's own /message route answers 200 even when the *upstream*
      // model call failed (e.g. the provider 404s) — the failure is folded
      // into `info.error` with `parts` left empty, never a non-ok HTTP
      // response. Trusting that as success would be the same mistake Claude
      // Code's `result.subtype === 'success'` almost caused for auth failures.
      if (message?.info?.error) {
        const upstream = message.info.error;
        throw new Error(`opencode: ${upstream.data?.message ?? upstream.name ?? 'the turn failed upstream'}`);
      }
      const mapped = toGatewayMessage(message);
      return {
        message: mapped,
        text: mapped.content.map((part) => part.text).join(''),
      };
    },

    async abort(sessionId) {
      await call(`/session/${encodeURIComponent(sessionId)}/abort`, { method: 'POST' });
    },

    async replyApproval(sessionId, requestId, reply) {
      await call(
        `/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
        { method: 'POST', body: JSON.stringify({ reply }) },
      );
    },

    /** Every model the CLI can actually reach, qualified by its own provider. */
    async listModels() {
      const config = await call('/config/providers');
      const models = [];
      for (const provider of config.providers ?? []) {
        for (const modelId of Object.keys(provider.models ?? {})) {
          models.push({
            id: `${provider.id}/${modelId}`,
            providerId: provider.id,
            modelId,
            label: `${provider.name ?? provider.id} · ${modelId}`,
            available: true,
          });
        }
      }
      return models;
    },

    /** Read the shared bus, exposing its ready point before a turn is sent. */
    streamEvents(sessionId, onEvent, signal) {
      let resolveReady;
      let rejectReady;
      const ready = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      // Direct callers may only await the stream; do not create an unhandled
      // rejection if the GET fails before they inspect its ready property.
      ready.catch(() => undefined);
      const done = (async () => {
        let reader;
        let finished = false;
        let removeAbortListener;
        const metadataLookups = new Map();
        const requestedLookups = new Set();
        const lookupControllers = new Set();
        const lookupTimers = new Set();
        // The cleanup body lives in the try's lexical scope, where the tool map,
        // held text and tracker it must clear are defined. Hoisting a no-op lets
        // a setup failure before those exist still run a safe cleanup.
        let cleanupStreamState = () => {};
        try {
          const response = await fetchImpl(`${root}/event`, {
            signal,
            headers: password ? { Authorization: `Bearer ${password}` } : {},
          });
          if (!response.ok) throw new Error(`OpenCode event stream refused: HTTP ${response.status}`);
          reader = response.body?.getReader();
          if (!reader) throw new Error('OpenCode event stream has no body');
          resolveReady();
          const decoder = new TextDecoder();
          let buffer = '';
          const toolCalls = new Map();
          // messageID -> role, learned from `message.updated`.
          const messageRoles = new Map();
          const parts = createOpenCodePartTracker();
          const pendingDeltas = new Map();
          // Every delivery funnels through here so a callback that aborts the
          // caller silences the frame behind it, whatever path produced it.
          const emit = (event) => {
            if (signal?.aborted) return;
            onEvent(event);
          };
          // A held snapshot used to be released only by the next bus frame, so
          // a tool that kept running left its newest input stranded until an
          // unrelated event arrived. One timer per call releases it at the
          // throttle's next boundary: the pending frame is replaced, never
          // queued, so coalescing keeps the newest input while the shared
          // deadline keeps the emit rate bounded to the minimum interval.
          const clearToolFlush = (state) => {
            if (!state?.timer) return;
            clearTimeout(state.timer);
            state.timer = null;
          };
          const scheduleToolFlush = (callId, state) => {
            if (state.timer || !state.pending) return;
            const wait = Math.max(0, TOOL_PROGRESS_MIN_INTERVAL_MS - (Date.now() - state.lastEmittedAt));
            state.timer = setTimeout(() => {
              state.timer = null;
              if (finished || signal?.aborted) return;
              // Only the state this timer was armed for may flush: the call
              // may have ended, or been replaced, while the timer waited.
              if (toolCalls.get(callId) !== state || !state.pending) return;
              const flushed = state.pending;
              state.pending = null;
              state.lastEmittedInputKey = toolInputKey(flushed.payload.input);
              state.lastEmittedAt = Date.now();
              emit(flushed);
            }, wait);
          };
          // A terminal frame or an abort ends the turn: any held progress is
          // dropped with it rather than emitted late behind the output.
          const clearToolFlushes = () => {
            for (const state of toolCalls.values()) clearToolFlush(state);
          };
          // The full body a recovery lookup returned, kept until the terminal
          // event so it can be reconciled against what actually reached the
          // client — never emitted alongside the live deltas it would duplicate.
          const recoveredSnapshots = new Map();
          // Cancel every armed per-call flush before dropping the retained text
          // and tool bookkeeping, so no timer can fire into maps that are gone.
          cleanupStreamState = () => {
            clearToolFlushes();
            toolCalls.clear();
            pendingDeltas.clear();
            recoveredSnapshots.clear();
            requestedLookups.clear();
            messageRoles.clear();
            parts.clear();
          };
          // Once the terminal frame is in hand, a lookup still settling must
          // only feed the terminal reconciliation, not flush live.
          let terminalPending = false;
          // Release the held text for one part to its now-known channel.
          const flushPartDeltas = (partId) => {
            if (finished || signal?.aborted) return;
            const queue = pendingDeltas.get(partId);
            if (!queue) return;
            pendingDeltas.delete(partId);
            for (const pending of queue) {
              if (signal?.aborted) return;
              const flushed = normalizeOpenCodeEvent(pending, parts);
              if (flushed) emit(flushed);
            }
          };
          // A first untyped delta names its message; the message route returns
          // every part, so one bounded lookup per message recovers the type and
          // releases the held text to the right channel. It runs alongside the
          // read loop, so unrelated known parts keep streaming, and metadata that
          // beats it wins: an already-typed part is never re-flushed.
          const recoverMessageParts = (messageId) => {
            if (!messageId || requestedLookups.has(messageId)) return;
            requestedLookups.add(messageId);
            const controller = new AbortController();
            lookupControllers.add(controller);
            const lookup = (async () => {
              let timer;
              try {
                const timeout = new Promise((_, reject) => {
                  timer = setTimeout(() => reject(new Error('metadata lookup timed out')), METADATA_LOOKUP_TIMEOUT_MS);
                  lookupTimers.add(timer);
                });
                const message = await Promise.race([
                  call(
                    `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`,
                    { signal: controller.signal },
                  ),
                  timeout,
                ]);
                if (finished || signal?.aborted) return;
                // The lookup answers for one message of one session. A response
                // that names another session or another message is not this
                // turn's data: refuse it wholesale before anything reaches the
                // tracker, the held queues or the client.
                const info = message?.info;
                if (info && typeof info === 'object') {
                  if (info.id && info.id !== messageId) return;
                  if (info.sessionID && info.sessionID !== sessionId) return;
                  if (typeof info.role === 'string') messageRoles.set(messageId, info.role);
                  // The prompt's own message is never the answer: its held
                  // text is dropped, not released.
                  if (info.role === 'user') {
                    for (const part of Array.isArray(message?.parts) ? message.parts : []) {
                      if (part?.id) pendingDeltas.delete(part.id);
                    }
                    return;
                  }
                }
                for (const part of Array.isArray(message?.parts) ? message.parts : []) {
                  if (!part?.id || !STREAMED_PART_TYPES.has(part.type)) continue;
                  if (parts.partType(part.id)) continue;
                  // A part that names a foreign session or message is not this
                  // turn's either; skip it rather than let it poison the type.
                  if (part.sessionID && part.sessionID !== sessionId) continue;
                  if (part.messageID && part.messageID !== messageId) continue;
                  // Legacy shapes carry no identity on the part; fill it from
                  // what was actually requested so the emission is owned.
                  const owned = {
                    ...part,
                    sessionID: part.sessionID ?? sessionId,
                    messageID: part.messageID ?? messageId,
                  };
                  parts.remember(owned);
                  if (typeof part.text === 'string') {
                    recoveredSnapshots.set(part.id, {
                      type: part.type,
                      text: part.text,
                      sessionID: owned.sessionID,
                      messageID: owned.messageID,
                    });
                  }
                  // At the terminal the snapshot is reconciled in one pass; a
                  // live lookup releases its held deltas to the known channel.
                  if (terminalPending) continue;
                  flushPartDeltas(part.id);
                }
              } catch {
                // Bounded failure: the delta stays held and the terminal event
                // reports it by id rather than guessing its channel.
              } finally {
                clearTimeout(timer);
                lookupTimers.delete(timer);
                lookupControllers.delete(controller);
                metadataLookups.delete(messageId);
              }
            })();
            metadataLookups.set(messageId, lookup);
          };
          // A buffered delta whose part type never arrived is unclassifiable:
          // `field:'text'` alone may be a thought, so it is never published as
          // the answer. At the terminal event, release only the parts that are
          // now typed; the rest are reported by identifier and count — never
          // raw text — so the run fails honestly instead of guessing.
          // Emit the missing suffix of a recovered part's snapshot. The tracker
          // subtracts what already reached the client, so a live delta followed
          // by the terminal pass never duplicates text.
          const emitRecoveredSnapshot = (partId) => {
            if (signal?.aborted) return false;
            const recovered = recoveredSnapshots.get(partId);
            if (!recovered) return false;
            const flushed = normalizeOpenCodeEvent({
              type: 'message.part.updated',
              properties: {
                sessionID: recovered.sessionID,
                part: {
                  id: partId,
                  type: recovered.type,
                  text: recovered.text,
                  sessionID: recovered.sessionID,
                  messageID: recovered.messageID,
                },
              },
            }, parts);
            if (flushed) emit(flushed);
            return true;
          };
          const flushPendingDeltas = () => {
            if (signal?.aborted) return null;
            const unclassified = [];
            let deltaCount = 0;
            for (const [partId, queue] of pendingDeltas) {
              if (parts.partType(partId)) {
                // Normalize the queued fragments first so the tracker learns
                // what already reached the client. The recovered snapshot may be
                // older than the queued text, so it is reconciled afterwards in
                // the suffix pass and only emits what the deltas did not send.
                for (const pending of queue) {
                  if (signal?.aborted) return null;
                  const flushed = normalizeOpenCodeEvent(pending, parts);
                  if (flushed) emit(flushed);
                }
                continue;
              }
              unclassified.push(partId);
              deltaCount += queue.length;
            }
            pendingDeltas.clear();
            // Reconcile snapshots whose queue already flushed live: only the
            // suffix no ordinary delta has sent is emitted, exactly once.
            for (const partId of recoveredSnapshots.keys()) {
              if (signal?.aborted) return null;
              if (parts.partType(partId)) emitRecoveredSnapshot(partId);
            }
            if (unclassified.length === 0) return null;
            return { partIds: unclassified, partCount: unclassified.length, deltaCount };
          };
          let abortRace;
          if (signal) {
            abortRace = new Promise((resolve) => {
              if (signal.aborted) { resolve(ABORTED); return; }
              const onAbort = () => resolve(ABORTED);
              signal.addEventListener('abort', onAbort, { once: true });
              removeAbortListener = () => signal.removeEventListener('abort', onAbort);
            });
          }
          while (true) {
            if (signal?.aborted) break;
            const result = abortRace ? await Promise.race([reader.read(), abortRace]) : await reader.read();
            if (result === ABORTED || signal?.aborted) break;
            const { done: ended, value } = result;
            if (ended) {
              if (!signal?.aborted) {
                throw new Error('OpenCode event stream ended before a terminal event');
              }
              break;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              // A callback that aborts must silence the lines still queued
              // behind it in this batch: the guard sits before every frame.
              if (signal?.aborted) break;
              if (!line.startsWith('data: ')) continue;
              let parsed;
              try {
                parsed = JSON.parse(line.slice(6));
              } catch {
                continue;
              }
              // The bus is global; a session's stream must not leak other
              // sessions. Scoping happens here, ahead of every cache the event
              // could reach, so a foreign part cannot share this session's
              // part id and poison the tracker, the pending-delta queues or
              // the tool call map.
              const scoped = scopeToSession(parsed, sessionId);
              if (!scoped) continue;
              parsed = scoped;
              // OpenCode publishes the prompt itself on this same bus: a
              // `message.updated` with role:user, then that message's text
              // part. Forwarding it streamed every reply with the user's own
              // prompt in front -- and, because that echo counted as "content
              // arrived", the turn runner no longer back-filled an answer the
              // stream then missed. Parts are dropped by their message's role,
              // which OpenCode announces before the message's parts.
              const roleInfo = parsed.type === 'message.updated' ? parsed.properties?.info : null;
              if (roleInfo?.id && typeof roleInfo.role === 'string') messageRoles.set(roleInfo.id, roleInfo.role);
              if (parsed.type === 'message.part.updated' || parsed.type === 'message.part.delta') {
                const ownerId = parsed.type === 'message.part.delta'
                  ? parsed.properties?.messageID
                  : parsed.properties?.part?.messageID ?? parsed.properties?.messageID;
                if (ownerId && messageRoles.get(ownerId) === 'user') continue;
              }
              // A streamed part's deltas name it only by id; its type arrives
              // on a separate `message.part.updated`. Hold undecided text
              // deltas until that metadata lands so a thought is never emitted
              // as the answer.
              if (parsed.type === 'message.part.delta'
                && parsed.properties?.field === 'text'
                && typeof parsed.properties.delta === 'string') {
                const partId = parsed.properties.partID;
                if (partId && !parts.partType(partId)) {
                  const queue = pendingDeltas.get(partId) ?? [];
                  queue.push(parsed);
                  pendingDeltas.set(partId, queue);
                  recoverMessageParts(parsed.properties.messageID);
                  continue;
                }
              }
              if (parsed.type === 'message.part.updated') {
                const part = parsed.properties?.part;
                if (part && STREAMED_PART_TYPES.has(part.type)) {
                  parts.remember(part);
                  flushPartDeltas(part.id);
                }
              }
              let normalized = normalizeOpenCodeEvent(parsed, parts);
              const callId = normalized?.payload?.callId;
              if (normalized?.type === 'tool.started' && callId) {
                let state = toolCalls.get(callId);
                if (state?.started) {
                  normalized = normalized.payload.input === undefined
                    ? null
                    : frame('tool.progress', { ...normalized.payload, snapshot: true });
                } else {
                  state ??= { lastObservedInputKey: undefined, lastEmittedInputKey: undefined, lastEmittedAt: 0, pending: null, timer: null };
                  state.started = true;
                  if (normalized.payload.input !== undefined) {
                    const key = toolInputKey(normalized.payload.input);
                    state.lastObservedInputKey = key;
                    state.lastEmittedInputKey = key;
                    state.lastEmittedAt = Date.now();
                  }
                  toolCalls.set(callId, state);
                }
              }
              if (normalized?.type === 'tool.progress' && callId && normalized.payload.snapshot) {
                const state = toolCalls.get(callId) ?? {
                  started: true,
                  lastObservedInputKey: undefined,
                  lastEmittedInputKey: undefined,
                  lastEmittedAt: 0,
                  pending: null,
                  timer: null,
                };
                toolCalls.set(callId, state);
                const inputKey = toolInputKey(normalized.payload.input);
                const now = Date.now();
                if (state.lastObservedInputKey === inputKey) {
                  if (state.pending && now - state.lastEmittedAt >= TOOL_PROGRESS_MIN_INTERVAL_MS) {
                    clearToolFlush(state);
                    normalized = state.pending;
                    state.pending = null;
                    state.lastEmittedInputKey = inputKey;
                    state.lastEmittedAt = now;
                  } else {
                    normalized = null;
                  }
                } else {
                  state.lastObservedInputKey = inputKey;
                  if (now - state.lastEmittedAt < TOOL_PROGRESS_MIN_INTERVAL_MS) {
                    // Held: the armed timer, if any, stays the one flush for
                    // this call and will carry whatever is newest by then.
                    state.pending = normalized;
                    normalized = null;
                  } else {
                    clearToolFlush(state);
                    state.pending = null;
                    state.lastEmittedInputKey = inputKey;
                    state.lastEmittedAt = now;
                  }
                }
                if (state.pending) scheduleToolFlush(callId, state);
              }
              if (normalized?.type === 'tool.output' && callId) {
                const state = toolCalls.get(callId);
                // The output settles the call: cancel the armed flush first so
                // a pending released here cannot be released a second time.
                clearToolFlush(state);
                if (state?.pending && state.pending.payload.input !== undefined
                  && toolInputKey(state.pending.payload.input) !== state.lastEmittedInputKey) {
                  emit(state.pending);
                }
                toolCalls.delete(callId);
              }
              if (normalized?.type === 'run.completed' || normalized?.type === 'run.failed') {
                // The turn is over: a held tool snapshot must not surface as a
                // progress frame behind the terminal one.
                clearToolFlushes();
                // Settle any in-flight metadata lookup before deciding whether a
                // completion is honest: a type still recoverable must not be
                // reported as an omission. Bounded, so a dead lookup cannot hang.
                terminalPending = true;
                if (metadataLookups.size > 0) {
                  let settleTimer;
                  // The wait is bounded by the lookup bound and by the caller's
                  // signal: an abort must not sit behind a lookup that stalls.
                  const settle = Promise.allSettled([...metadataLookups.values()]);
                  const bounded = [
                    settle,
                    new Promise((resolve) => { settleTimer = setTimeout(resolve, METADATA_LOOKUP_TIMEOUT_MS); }),
                  ];
                  if (abortRace) bounded.push(abortRace);
                  await Promise.race(bounded);
                  clearTimeout(settleTimer);
                }
                // The signal won the race: the terminal frame and the caches it
                // would write are dropped rather than delivered after the caller
                // has gone. The lookup itself is aborted by the finally below.
                if (signal?.aborted) return;
                // No later lookup may append after the terminal frame.
                finished = true;
                const unclassified = flushPendingDeltas();
                if (unclassified) {
                  emit(frame('diagnostic', {
                    sessionId,
                    source: 'message.part.delta',
                    reason: 'unclassifiable-part-metadata',
                    ...unclassified,
                  }));
                  // Never claim completion over an omission: an idle that still
                  // holds unclassifiable text is a failure, not a silent win.
                  if (normalized.type === 'run.completed') {
                    normalized = frame('run.failed', {
                      sessionId,
                      message: `stream closed with ${unclassified.deltaCount} buffered text delta(s) across ${unclassified.partCount} part(s) whose type never arrived`,
                    });
                  }
                }
                emit(normalized);
                return;
              }
              if (normalized) emit(normalized);
            }
          }
        } catch (error) {
          rejectReady(error);
          throw error;
        } finally {
          finished = true;
          removeAbortListener?.();
          // Final cleanup drops the turn's held text and tool bookkeeping with
          // their armed flush timers, so a lookup that never cooperates cannot
          // keep completed-turn content reachable past the stream's end.
          cleanupStreamState();
          for (const controller of lookupControllers) controller.abort();
          for (const timer of lookupTimers) clearTimeout(timer);
          lookupControllers.clear();
          lookupTimers.clear();
          metadataLookups.clear();
          let cancelTimer;
          await Promise.race([
            reader?.cancel().catch(() => undefined) ?? Promise.resolve(),
            new Promise((resolve) => { cancelTimer = setTimeout(resolve, STREAM_CLEANUP_TIMEOUT_MS); }),
          ]);
          clearTimeout(cancelTimer);
        }
      })();
      done.ready = ready;
      return done;
    },
  };
}
