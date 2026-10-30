import { mkdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { writeFileAtomic } from '../../atomic-file.mjs';
import {
  flattenModels,
  isBotAgent,
  renderAgentFile,
  resolveModelPin,
  toPublicAgentBot,
  validateBotId,
} from '../opencode-agents.mjs';

/**
 * OpenCode as a chat backend.
 *
 * OpenCode owns its own sessions, model catalog, tools and approvals; the Gate
 * proxies to them rather than reimplementing any of it. Shapes here are the ones
 * verified live against 1.18.18 — see docs/opencode-backend-contract.md — plus a
 * v2 (2.0.x) codepath branched by the detected server major, verified live
 * against 2.0.32 (docs/plans/PLAN-backend-outages-2026-10-21.md and
 * temp/oc-v2-probe-findings.md).
 */

/**
 * Classify a contacted OpenCode server as major 1 or 2.
 *
 * v2 moved the API under /api/* and made auth always-on HTTP Basic; v1 serves
 * a JSON array at /session (opt-in Bearer). The v1 probe goes first because it
 * is the cheap answer for an unauthenticated v1 server; a v2 server's SPA
 * catch-all answers /session with 200 text/html, which fails JSON parsing and
 * falls through to the v2 probes. A 401 from /api/info identifies v2 as surely
 * as a 200 — only a v2 server has that route — which keeps classification
 * working even when the password is missing or wrong.
 *
 * Returns null when no probe identifies the server (then the caller's legacy
 * behavior applies); never throws for transport failures.
 */
export async function detectOpenCodeServerMajor({ fetchImpl, baseUrl, password, timeoutMs = 2_000 }) {
  const root = String(baseUrl).replace(/\/+$/, '');
  const basic = password
    ? { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` }
    : {};
  const bearer = password ? { Authorization: `Bearer ${password}` } : {};
  const probes = [
    { major: 1, path: '/session', headers: bearer },
    { major: 2, path: '/api/info', headers: basic },
    { major: 1, path: '/session', headers: {} },
    { major: 2, path: '/api/info', headers: {} },
  ];
  for (const probe of probes) {
    try {
      const response = await fetchImpl(`${root}${probe.path}`, {
        headers: probe.headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (probe.major === 2 && response?.status === 401) return 2;
      if (!response?.ok) continue;
      const parsed = JSON.parse(await response.text());
      if (probe.major === 2 && typeof parsed?.version === 'string') return 2;
      if (probe.major === 1 && Array.isArray(parsed)) return 1;
    } catch {
      // try the next probe
    }
  }
  return null;
}

/** v2 servers always-on Basic auth: user `opencode`, server-set password. */
function v2AuthHeaders(password) {
  return password
    ? { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` }
    : {};
}

/** Translate an OpenCode 2.x session into the shape the app already parses. */
export function toGatewaySessionV2(session) {
  const tokens = session.tokens ?? {};
  return {
    id: session.id,
    source: 'opencode',
    user_id: null,
    model: session.model?.id ?? session.model?.modelID ?? null,
    title: session.title ?? null,
    started_at: session.time?.created ?? Date.now(),
    ended_at: null,
    end_reason: session.outcome ?? null,
    message_count: 0,
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

/** Flatten an OpenCode 2.x message (user or assistant). */
export function toGatewayMessageV2(message) {
  const contentParts = Array.isArray(message.content) ? message.content : [];
  const content = contentParts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => ({ type: 'text', text: part.text }));
  // The list projection carries a user turn's text as a top-level `text`
  // string, not as a content part (verified live on 2.0.32).
  if (content.length === 0 && typeof message.text === 'string' && message.text) {
    content.push({ type: 'text', text: message.text });
  }
  const toolCalls = contentParts
    .filter((part) => part.type === 'tool')
    .map((part) => ({ name: part.name, status: mapToolStatus(part.state?.status), id: part.id }));
  return {
    id: message.id,
    role: message.type === 'user' ? 'user' : 'assistant',
    content,
    timestamp: message.time?.created,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function toolContentText(content) {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
  return text || undefined;
}

/**
 * Reshape a v2 single-message GET into the v1 recovery envelope
 * (`{info, parts}`) the stream metadata path already validates and tracks.
 * Tool parts carry `tool`/`callID` the way v1 named them.
 */
function toV1MessageEnvelope(message, sessionId) {
  if (!message || typeof message !== 'object') return message;
  if (message.info || message.parts) return message;
  const content = Array.isArray(message.content) ? message.content : [];
  return {
    info: { id: message.id, sessionID: sessionId, role: message.type },
    parts: content.map((part, index) => part?.type === 'tool'
      ? {
          id: part.id,
          type: 'tool',
          tool: part.name,
          callID: part.id,
          sessionID: sessionId,
          messageID: message.id,
          state: {
            status: part.state?.status,
            input: part.state?.input,
            output: toolContentText(part.state?.content),
            error: part.state?.error,
          },
        }
      : {
          id: `${message.id}:${index}`,
          type: part?.type,
          text: part?.text,
          sessionID: sessionId,
          messageID: message.id,
        }),
  };
}

/** Translate an OpenCode session into the shape the app already parses. */
export function toGatewaySession(session) {
  const tokens = session.tokens ?? {};
  return {
    id: session.id,
    source: 'opencode',
    user_id: null,
    model: session.model?.modelID ?? null,
    bot: typeof session.agent === 'string' && session.agent ? session.agent : null,
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
 * Turn a finished OpenCode message into what the caller asked for.
 *
 * OpenCode's own /message route answers 200 even when the *upstream* model call
 * failed (e.g. the provider 404s) — the failure is folded into `info.error` with
 * `parts` left empty, never a non-ok HTTP response. Trusting that as success
 * would be the same mistake Claude Code's `result.subtype === 'success'` almost
 * caused for auth failures.
 */
function turnResult(message) {
  const upstream = message?.info?.error;
  if (upstream) {
    throw new Error(`opencode: ${upstream.data?.message ?? upstream.name ?? 'the turn failed upstream'}`);
  }
  if (!message) return { message: null, text: '' };
  const mapped = toGatewayMessage(message);
  return { message: mapped, text: mapped.content.map((part) => part.text).join('') };
}

/**
 * The turn's own assistant message, and only that one.
 *
 * The session's *last* assistant message is the previous turn's answer whenever
 * this turn produced none — an upstream failure that created no message, a turn
 * that ended empty — and serving it again would answer the operator with the
 * answer they already have. A message is this turn's when this turn's send
 * created it; the slop absorbs the clock difference between the Gate and the
 * server, which is the only other thing that could make a fresh message look
 * older than the send that produced it.
 */
function thisTurnAssistantMessage(messages, sentAt) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.info?.role !== 'assistant') continue;
    const created = list[index]?.info?.time?.created;
    if (typeof created === 'number' && created >= sentAt - TURN_START_SLOP_MS) return list[index];
  }
  return null;
}

/**
 * The v2 message projection names the role `type` and stamps `time.created`
 * in epoch milliseconds (verified live on 2.0.32), so the same slop-based
 * ownership test applies. A tool-using turn materializes SEVERAL assistant
 * messages — step artifacts with empty content can be the newest — so the
 * scan prefers the newest assistant that actually carries text and only
 * falls back to the newest matching one when no candidate has any.
 */
function thisTurnAssistantMessageV2(messages, sentAt) {
  const list = Array.isArray(messages) ? messages : [];
  let newest = null;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.type !== 'assistant') continue;
    const created = list[index]?.time?.created;
    if (typeof created !== 'number' || created < sentAt - TURN_START_SLOP_MS) continue;
    if (!newest) newest = list[index];
    const hasText = (Array.isArray(list[index]?.content) ? list[index].content : []).some(
      (part) => part?.type === 'text' && typeof part.text === 'string' && part.text.length > 0,
    );
    if (hasText) return list[index];
  }
  return newest;
}

/**
 * Turn a finished v2 assistant message into what the caller asked for.
 *
 * v2 folds upstream failures into `error` (a StructuredError) or a `finish`
 * of `'error'`, and the synthetic `idle` message that ends every turn carries
 * the overall `outcome` — trust any of them as failure, like v1's
 * `info.error`, never as an answer.
 */
function turnResultV2(message, idleOutcome) {
  const upstream = message?.error
    ?? (message?.finish === 'error' ? { message: 'the turn failed upstream' } : null)
    ?? (idleOutcome && idleOutcome !== 'succeeded' ? { message: `the session went idle with outcome "${idleOutcome}"` } : null);
  if (upstream) {
    throw new Error(`opencode: ${errorText(upstream.message) || upstream.type || 'the turn failed upstream'}`);
  }
  if (!message) return { message: null, text: '' };
  const mapped = toGatewayMessageV2(message);
  return { message: mapped, text: mapped.content.map((part) => part.text).join('') };
}

/** How a model is named in a failure the operator reads on their phone. */
function modelLabel(model) {
  if (model?.providerId && model?.modelId) return `${model.providerId}/${model.modelId}`;
  return model?.modelId ?? null;
}

/**
 * The reason a silent turn is reported with: the model, the wait it was given,
 * and what OpenCode said about the provider while it kept saying nothing.
 */
function silentTurnReason(model, boundMs, retryNote) {
  // Never report a zero-second wait: an injected sub-second bound rounds up.
  const seconds = Math.max(1, Math.round(boundMs / 1000));
  const name = modelLabel(model);
  const lead = name ? `${name} did not answer` : 'the model did not answer';
  const why = retryNote ? ` (the provider kept failing: ${retryNote})` : '';
  return `${lead} within ${seconds} s. OpenCode stopped the turn - try another model.${why}`;
}

/** Whatever a `session.status` retry frame says about why the provider is failing. */
function retryReason(properties) {
  const message = properties?.message ?? properties?.reason ?? errorText(properties?.error);
  return typeof message === 'string' ? message.trim() : '';
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
/** Stopping a turn must not be able to hang the failure that reports it. */
const TURN_STOP_TIMEOUT_MS = 2000;
/**
 * Bounds on a turn the server has already accepted. A model that accepts a turn
 * and then never answers leaves the bus completely silent, so without these the
 * turn waits out the transport's own 300 s headers timeout and the operator
 * reads "could not reach ... (Headers Timeout Error)" instead of a reason — while
 * OpenCode keeps burning the turn with nobody watching. Before the first
 * assistant output a silent turn is already a dead one; after it, a slow model is
 * still working and gets the longer bound. A running tool part suspends both.
 */
export const OPENCODE_FIRST_OUTPUT_IDLE_MS = 60_000;
export const OPENCODE_IDLE_MS = 180_000;
/**
 * How long a turn's bus subscription gets to prove it is live before the prompt
 * is posted. The send waits for the ready point, never for the feed itself: a
 * subscription that opens slowly must not delay the turn, and one that never
 * opens cannot lose the answer either, because the silence bound re-reads the
 * session's messages before it calls a turn dead.
 */
const BUS_READY_TIMEOUT_MS = 3000;
/** Reading the session's messages back must not hold a turn that is over. */
const TURN_MESSAGES_TIMEOUT_MS = 5000;
/**
 * How long a route read may take before it is called a failure.
 *
 * A wedged `opencode serve` accepts the connection and then says nothing — its
 * first start after a reboot alone takes well over 30 s (see
 * cli-environments/native-server.mjs) — and undici's own ~300 s headers timeout
 * is the only bound there was, so the operator read "could not reach … (Headers
 * Timeout Error)" instead of a reason, on every session list, message read,
 * model list, turn read-back and Stop. A metadata read is a read a screen waits
 * on, and hanging is never the right answer for one: the same ceiling the Hermes
 * backend states for exactly this reason.
 */
const READ_TIMEOUT_MS = 30_000;
/** How far before the send a message may be created and still be this turn's. */
const TURN_START_SLOP_MS = 2000;
const ABORTED = Symbol('aborted');
/**
 * What a cancelled send fails with, whichever step it had reached: the caller
 * pressed Stop, not the server and not the model, and the public shape of that
 * answer does not change with where the cancellation landed.
 */
const ABORTED_TURN_MESSAGE = 'opencode: the turn was aborted';

function turnAbortedError() {
  return new Error(ABORTED_TURN_MESSAGE);
}

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
 * A value inside a bound, or `undefined` when the wait runs out or the promise
 * fails. Used only where the answer is a witness rather than the record — a
 * subscription that has not opened yet, a route read that will not answer — so
 * that neither can hold a turn that is otherwise over.
 */
function boundedValue(promise, ms) {
  let timer;
  const expiry = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
  });
  return Promise.race([
    Promise.resolve(promise).then((value) => value, () => undefined),
    expiry,
  ]).finally(() => clearTimeout(timer));
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

/**
 * Map an OpenCode 2.x SSE frame ({id, type, data}) onto the v1-shaped event
 * vocabulary that normalizeOpenCodeEvent already understands, so the entire
 * streaming pipeline (part tracker, role holding, tool coalescing, terminal
 * reconciliation) is shared between majors. Catalog verified live against
 * 2.0.32 — see temp/oc-v2-probe-findings.md.
 *
 * v2 streams text/reasoning per (assistantMessageID, ordinal) with no part
 * ids of their own, so a part id is synthesized as `<messageID>:<ordinal>`;
 * `session.step.started` is translated to a role-carrying `message.updated`
 * so the answer's deltas are never held waiting for a role the v2 bus does
 * not send. Events with no translation pass through as diagnostics (with
 * their sessionID, so the bus scoping filter still applies).
 */
export function translateV2Event(frameEvent) {
  if (!frameEvent || typeof frameEvent.type !== 'string') return null;
  const data = frameEvent.data && typeof frameEvent.data === 'object' ? frameEvent.data : {};
  const sessionID = sessionToken(data.sessionID);
  const messageID = sessionToken(data.assistantMessageID);
  const partId = (ordinal) => (messageID ? `${messageID}:${typeof ordinal === 'number' ? ordinal : 0}` : null);
  const partUpdated = (part) => ({ type: 'message.part.updated', properties: { sessionID, part } });
  const toolPart = (state) => ({
    id: data.id,
    type: 'tool',
    tool: data.name,
    callID: data.id,
    sessionID,
    messageID,
    state,
  });
  const passThrough = () => ({ type: frameEvent.type, properties: { ...data } });

  switch (frameEvent.type) {
    case 'session.text.started':
      return messageID
        ? partUpdated({ id: partId(data.ordinal), type: 'text', text: '', sessionID, messageID })
        : passThrough();
    case 'session.text.delta':
      return messageID
        ? { type: 'message.part.delta', properties: { sessionID, messageID, partID: partId(data.ordinal), field: 'text', delta: data.delta } }
        : passThrough();
    case 'session.text.ended':
      return messageID
        ? partUpdated({ id: partId(data.ordinal), type: 'text', text: data.text, sessionID, messageID })
        : passThrough();
    case 'session.reasoning.started':
      return messageID
        ? partUpdated({ id: partId(data.ordinal), type: 'reasoning', text: '', sessionID, messageID })
        : passThrough();
    case 'session.reasoning.delta':
      return messageID
        ? { type: 'message.part.delta', properties: { sessionID, messageID, partID: partId(data.ordinal), field: 'reasoning', delta: data.delta } }
        : passThrough();
    case 'session.reasoning.ended':
      return messageID
        ? partUpdated({ id: partId(data.ordinal), type: 'reasoning', text: data.text, sessionID, messageID })
        : passThrough();
    case 'session.tool.input.started':
      return partUpdated(toolPart({ status: 'pending' }));
    case 'session.tool.input.ended': {
      let input;
      try {
        input = JSON.parse(data.text);
      } catch {
        input = undefined;
      }
      return partUpdated(toolPart({ status: 'running', input }));
    }
    case 'session.tool.called':
      return partUpdated(toolPart({ status: 'running', input: data.input }));
    case 'session.tool.success':
      return partUpdated(toolPart({ status: 'completed', output: toolContentText(data.content) }));
    case 'session.tool.failed':
      return partUpdated(toolPart({ status: 'error', output: toolContentText(data.content), error: data.error }));
    case 'session.step.started':
      // Seeds the role of the step's assistant message before its parts
      // stream; normalize drops it to a diagnostic (no tokens yet).
      return { type: 'message.updated', properties: { sessionID, info: { id: messageID, sessionID, role: 'assistant' } } };
    case 'session.step.ended':
    case 'session.usage.updated':
      return { type: 'message.updated', properties: { sessionID, info: { id: messageID, sessionID, role: 'assistant', tokens: data.tokens, cost: data.cost } } };
    case 'session.execution.failed':
      return { type: 'session.error', properties: { sessionID, error: data.error } };
    case 'session.execution.interrupted':
      return { type: 'session.error', properties: { sessionID, error: { message: 'the turn was interrupted' } } };
    case 'session.execution.completed':
    case 'session.execution.ended':
    case 'session.idle':
      // Defensive: no success-terminal bus frame was observed on 2.0.32 —
      // the experimental wait route is the authoritative completion signal —
      // but map these if a future build emits them.
      return { type: 'session.idle', properties: { sessionID } };
    case 'session.retry.scheduled':
      return { type: 'session.status', properties: { sessionID, type: 'retry', message: errorText(data.error), attempt: data.attempt } };
    default:
      return passThrough();
  }
}

/** Build a backend bound to a running OpenCode server. */
export function createOpenCodeBackend({
  baseUrl,
  fetchImpl = fetch,
  password,
  // The workspace directory every v2 session-scoped call is location-scoped
  // to (`?location[directory]=…`); v1 ignores it.
  directory = null,
  // The silence bounds are injectable so a test proves the failure without
  // waiting one out; production takes the exported defaults.
  firstOutputIdleMs = OPENCODE_FIRST_OUTPUT_IDLE_MS,
  idleMs = OPENCODE_IDLE_MS,
  readTimeoutMs = READ_TIMEOUT_MS,
  // Where agent files live. Left unset it is asked of the server (`GET /path`),
  // which knows its own config directory whoever started it.
  agentsDir,
  // The Gate only ever serves free models here (ADR 0016).
  freeOnly = true,
  writeFile = writeFileAtomic,
  readText = (path) => readFile(path, 'utf8'),
  removeFile = unlink,
  ensureDir = (path) => mkdir(path, { recursive: true }),
} = {}) {
  const root = String(baseUrl).replace(/\/+$/, '');
  const workspace = typeof directory === 'string' && directory ? directory : null;

  /**
   * The detected server major, cached for the backend's lifetime. A server
   * that classifies as nothing (not reachable, or not an OpenCode server) is
   * treated as v1: the legacy routes then fail with named HTTP errors instead
   * of a classification error that would hide them.
   */
  let profilePromise = null;
  function serverProfile() {
    if (!profilePromise) {
      // Bounded: a server that accepts connections but never answers a probe
      // must not hold every read hostage — the legacy path then fails with the
      // read ceiling's own named timeout instead of a classification stall.
      const ceilingMs = Math.min(Math.max(readTimeoutMs * 2, 1_000), 2_500);
      profilePromise = Promise.race([
        detectOpenCodeServerMajor({ fetchImpl, baseUrl: root, password }),
        new Promise((resolve) => setTimeout(() => resolve(null), ceilingMs)),
      ]).then((major) => ({ major: major ?? 1 }));
      profilePromise.catch(() => undefined);
    }
    return profilePromise;
  }

  /** The v2 location scope, or '' when no workspace directory is configured. */
  const locationQuery = () => (workspace ? `?location[directory]=${encodeURIComponent(workspace)}` : '');
  /** A v2 query string combining the location scope with extra params. */
  const v2Query = (extra = '') => {
    if (!extra) return locationQuery();
    return `${locationQuery()}&${extra}`;
  };

  /**
   * One paginated read of every message of a v2 session, following
   * `cursor.next` until exhausted — the single shared reader for listMessages,
   * turn read-backs and stream metadata lookups.
   */
  async function readMessagesV2(sessionId, signal) {
    const messages = [];
    let cursor = null;
    while (true) {
      const page = await call(
        `/api/session/${encodeURIComponent(sessionId)}/message${v2Query(cursor ? `cursor=${encodeURIComponent(cursor)}` : '')}`,
        signal ? { signal } : {},
        readTimeoutMs,
        2,
        false,
      );
      const data = Array.isArray(page?.data) ? page.data : [];
      messages.push(...data);
      const next = page && typeof page === 'object' ? page.cursor?.next : null;
      if (!next) return messages;
      cursor = next;
    }
  }

  /** A route that answered nothing within its own ceiling for this backend. */
  function routeTimeoutError(path, timeoutMs) {
    const seconds = Math.max(1, Math.round(timeoutMs / 1000));
    return Object.assign(
      new Error(
        `opencode: ${root}${path} sent no response within ${seconds}s — ` +
        'the server is running but it is not answering',
      ),
      { code: 'backend_timeout' },
    );
  }

  /**
   * One route read, under a ceiling this backend owns.
   *
   * `timeoutMs` is the caller's own bound and defaults to the read ceiling; a
   * caller that brought a signal of its own (a turn's abort, the bounded message
   * read) keeps it, because those bounds are tighter and mean something specific
   * to the turn. The turn-bearing blocking route is given `idleMs` instead: it
   * answers only when the whole turn is done, so it is a turn, not a read.
   *
   * `major` selects the wire protocol: v2 (2.0.x) authenticates with HTTP Basic
   * `opencode:<password>` (always on — Bearer gets a 401) and wraps every
   * payload in `{data: …}`; v1 is opt-in Bearer with bare payloads. `unwrap`
   * is false for the paginated message list, whose `cursor` rides next to
   * `data` and must survive the read.
   */
  async function call(path, init = {}, timeoutMs = readTimeoutMs, major = 1, unwrap = true) {
    const headers = { ...(init.headers ?? {}) };
    if (init.body) headers['Content-Type'] = 'application/json';
    if (password) {
      headers.Authorization = major >= 2
        ? `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
        : `Bearer ${password}`;
    }
    const bounded = !init.signal && Number.isFinite(timeoutMs) && timeoutMs > 0;
    const response = await fetchImpl(`${root}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? (bounded ? AbortSignal.timeout(timeoutMs) : undefined),
    }).catch((err) => {
      // Named, and not phrased as silence: this is a transport that stopped
      // answering, which is a fact about the server rather than about the model
      // the turn was about — model-fault.mjs reads the difference that way.
      if (bounded && (err?.name === 'TimeoutError' || err?.name === 'AbortError')) {
        throw routeTimeoutError(path, timeoutMs);
      }
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
      // The status rides along: a 404 is the only answer that means "this server
      // has no such route", which is how the async prompt falls back.
      throw Object.assign(new Error(`opencode: ${message}`), { status: response.status });
    }
    // A real opencode 1.18.18 accepts a turn with 204 and NO body (verified live
    // 2026-10-02: status 204, no content-length, zero bytes) and then runs it on
    // the bus. `response.json()` on that throws `Unexpected end of JSON input`
    // before the bus wait begins, so the turn is reported failed while the server
    // is running it — and the model-health table reads that as the model's fault.
    // So an ok answer with nothing in it is a success that carries no value, and
    // a 204/205 says so outright; only a body that is really there is parsed.
    if (response.status === 204 || response.status === 205) return null;
    const text = await response.text();
    if (!text.trim()) return null;
    const parsed = JSON.parse(text);
    // v2 wraps every payload in {data: …}; v1 returns it bare.
    if (major >= 2 && unwrap && parsed && typeof parsed === 'object' && 'data' in parsed) {
      return parsed.data;
    }
    return parsed;
  }

  /** Best-effort stop of a turn the server is still running, and bounded. */
  async function stopTurn(sessionId, major = 1) {
    const path = major >= 2
      ? `/api/session/${encodeURIComponent(sessionId)}/interrupt${locationQuery()}`
      : `/session/${encodeURIComponent(sessionId)}/abort`;
    const controller = new AbortController();
    let timer;
    try {
      await Promise.race([
        call(path, { method: 'POST', signal: controller.signal }, readTimeoutMs, major)
          .catch(() => undefined),
        new Promise((resolve) => { timer = setTimeout(resolve, TURN_STOP_TIMEOUT_MS); }),
      ]);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  /**
   * The POST that submits a prompt.
   *
   * A prompt route is special in two ways at once: the caller's Stop has to
   * reach it, because a cancelled message must never be accepted behind the
   * operator's back, and a wedged server still must not hold it forever, so the
   * route keeps the ceiling it had before it carried a signal. Cancellation wins
   * over the transport's own wording — the caller reads the cancellation it
   * asked for, not a URL and not a cause.
   */
  async function postPrompt(path, body, signal, major = 1, timeoutMs = readTimeoutMs) {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    let timer;
    let timedOut = false;
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      timer.unref?.();
    }
    try {
      // `call` is handed the controller rather than the caller's signal so the
      // route's ceiling and the cancellation share one request signal; the
      // timeout is named here because `call` cannot tell the two apart.
      return await call(path, { method: 'POST', body, signal: controller.signal }, 0, major);
    } catch (error) {
      if (signal?.aborted) throw turnAbortedError();
      if (timedOut) throw routeTimeoutError(path, timeoutMs);
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  /**
   * A cancellation that landed while a prompt route was open.
   *
   * The route may already have been accepted, so the requested session is
   * stopped with the same bounded mechanism a Stop uses, and nothing is ever
   * re-sent. The caller gets the one cancellation failure, promptly.
   */
  async function stopCancelledSend(sessionId, major, turn) {
    turn.close();
    await stopTurn(sessionId, major);
    throw turnAbortedError();
  }

  /** The session's messages, read back once and bounded. */
  async function readTurnMessages(sessionId, major = 1) {
    const controller = new AbortController();
    try {
      return await boundedValue(
        major >= 2
          ? readMessagesV2(sessionId, controller.signal)
          : call(`/session/${encodeURIComponent(sessionId)}/message`, { signal: controller.signal }),
        TURN_MESSAGES_TIMEOUT_MS,
      );
    } finally {
      controller.abort();
    }
  }

  /**
   * A turn's bus subscription and the wait it settles, both live from before the
   * prompt is posted.
   *
   * The turn can be over before the send that started it has been answered — a
   * provider that refuses at once, a cached reply — so a subscription opened
   * after the POST has already missed the `session.idle`/`session.error` that
   * ended it. The wait then sees silence for a turn that is over, stops a turn
   * that is done and reports "<model> did not answer" for an answer that was
   * already in the session. Hence the subscribe-then-send order.
   *
   * `major` selects the wire routes (v2 aborts via /interrupt and reads
   * messages paginated) and `watchIdle` lets the v2 send path feed the
   * experimental wait route in as an extra settle source: 2.0.x was verified
   * to emit no success-terminal bus frame, so the wait route's 204 is the
   * authoritative "session went idle" signal there.
   */
  function openTurnBus(sessionId, model, signal, major = 1) {
    const controller = new AbortController();
    const runningTools = new Set();
    let startedOutput = false;
    let retryNote = '';
    let feedDead = false;
    let timer = null;
    let settled = false;
    let idleController = null;
    let resolveOutcome;
    let resolveCancelled;
    const outcome = new Promise((resolve) => { resolveOutcome = resolve; });
    // The ready wait's own release: a Stop arrives before the subscription has
    // opened, and the send must not sit out the ready ceiling before it can act
    // on the cancellation.
    const cancelled = new Promise((resolve) => { resolveCancelled = resolve; });
    const bound = () => (startedOutput ? idleMs : firstOutputIdleMs);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      timer = null;
      try {
        idleController?.abort();
      } catch {
        /* the wait fetch is best-effort */
      }
      resolveOutcome(value);
    };
    // Silence is measured from the last sign of life, never from the send.
    const arm = () => {
      if (settled) return;
      clearTimeout(timer);
      timer = null;
      // A long tool is the turn working, not a dead turn: no bound while one runs.
      // A dead feed is the opposite — no progress can arrive to clear the bound,
      // so it stays armed even if a tool was running when the feed died.
      if (!feedDead && runningTools.size > 0) return;
      timer = setTimeout(() => finish({ kind: 'silent', boundMs: bound() }), bound());
      timer.unref?.();
    };
    const onEvent = (event) => {
      if (settled) return;
      const type = event?.type;
      if (type === 'run.completed') { finish({ kind: 'idle' }); return; }
      if (type === 'run.failed') { finish({ kind: 'failed', error: event.payload?.error }); return; }
      if (type === 'message.delta') startedOutput = true;
      const callId = event?.payload?.callId ?? '#tool';
      if (type === 'tool.started' || type === 'tool.progress') runningTools.add(callId);
      else if (type === 'tool.output') runningTools.delete(callId);
      const status = type === 'diagnostic' && event.payload?.source === 'session.status'
        ? event.payload.properties
        : null;
      // A retry is the provider failing, not the turn progressing: the clock
      // keeps running and the reason goes into the failure.
      if (status?.type === 'retry') {
        retryNote = retryReason(status) || retryNote;
        return;
      }
      arm();
    };
    // The caller's signal ends the turn and the wait, and stops the server's
    // turn with them — an abort that leaves OpenCode working is not an abort.
    const onCallerAbort = () => {
      controller.abort();
      finish({ kind: 'aborted' });
      resolveCancelled();
    };
    const close = () => {
      controller.abort();
      // The bus is no longer this turn's witness: its silence timer and the
      // caller's listener are retired with it, so a closed turn holds neither.
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      signal?.removeEventListener('abort', onCallerAbort);
    };
    if (signal?.aborted) onCallerAbort();
    else signal?.addEventListener('abort', onCallerAbort, { once: true });

    /**
     * Wait out a turn the server has already accepted, and complete it from the
     * bus.
     *
     * The blocking route answers only when the whole turn is done, so the wait
     * for a model that never answers is the transport's headers timeout and the
     * turn keeps running after the Gate has given up. `prompt_async` returns at
     * once instead: the answer is read back off the session when it goes idle,
     * and what counts as a sign of life is decided here — any event for this
     * session, with two exceptions that are not progress at all: a `session.status`
     * of type `retry` (OpenCode failing over to the provider) and a tool part that
     * is legitimately still running.
     */
    async function awaitTurnOnBus(sentAt) {
      try {
        const settledOutcome = await outcome;
        if (settledOutcome.kind === 'idle') {
          const messages = major >= 2
            ? await readMessagesV2(sessionId)
            : await call(`/session/${encodeURIComponent(sessionId)}/message`);
          if (major >= 2) {
            const idle = [...(Array.isArray(messages) ? messages : [])].reverse().find((m) => m?.type === 'idle');
            return turnResultV2(thisTurnAssistantMessageV2(messages, sentAt), idle?.outcome);
          }
          return turnResult(thisTurnAssistantMessage(messages, sentAt));
        }
        if (settledOutcome.kind === 'failed') {
          throw new Error(`opencode: ${errorText(settledOutcome.error) || 'the turn failed upstream'}`);
        }
        if (settledOutcome.kind === 'silent') {
          // The bus is a witness, not the record: a turn that ended while the
          // subscription was still opening (or after it died) emitted the frame
          // that ended it to nobody. Ask the session whether this turn finished
          // before stopping it and calling it silent.
          const readBack = await readTurnMessages(sessionId, major);
          if (major >= 2) {
            const finished = thisTurnAssistantMessageV2(readBack, sentAt);
            if (finished?.time?.completed) return turnResultV2(finished);
          } else {
            const finished = thisTurnAssistantMessage(readBack, sentAt);
            if (finished?.info?.time?.completed) return turnResult(finished);
          }
        }
        // Give up on a turn nobody is answering for, and stop the server's turn
        // before saying so: the next attempt would otherwise fight this one.
        await stopTurn(sessionId, major);
        if (settledOutcome.kind === 'aborted') throw turnAbortedError();
        throw new Error(silentTurnReason(model, settledOutcome.boundMs, retryNote));
      } finally {
        // The subscription is closed, never awaited: a feed that ignores its
        // signal must not hold a turn that has already settled.
        close();
      }
    }

    let subscription = null;
    if (!settled) {
      arm();
      subscription = backend.streamEvents(sessionId, onEvent, controller.signal);
      // A feed that fails is silence from then on: the bound still ends the
      // turn, and the wait re-reads the session before it calls it dead.
      Promise.resolve(subscription).catch(() => {
        feedDead = true;
        arm();
      });
    }
    return {
      // The subscription's own proof that it is live, bounded: the send waits
      // for the ready point and never for the feed itself. The caller's abort
      // releases it too, so a Stop pressed while the feed is still opening is
      // acted on at once instead of after the ready ceiling.
      ready: boundedValue(
        Promise.race([subscription?.ready, cancelled]),
        BUS_READY_TIMEOUT_MS,
      ),
      wait: awaitTurnOnBus,
      close,
      /**
       * v2 only: feed the experimental wait route in as an extra settle
       * source. Its 204 means the session went idle — the completion signal
       * the 2.0.x bus was verified not to emit. Its failure is not turn
       * state; the silence bounds still apply. Aborted when the turn
       * settles so a slow wait fetch cannot outlive its turn.
       */
      watchIdle: (promise, controller) => {
        idleController = controller;
        // A turn that settled while the prompt was still being accepted already
        // ran its settle-time cleanup, before this controller existed: the wait
        // must not outlive the turn it belongs to.
        if (settled) {
          Promise.resolve(promise).catch(() => undefined);
          controller.abort();
          return;
        }
        Promise.resolve(promise).then(
          () => finish({ kind: 'idle' }),
          () => arm(),
        );
      },
    };
  }

  const fail = (message, code, status) => {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
  };

  async function readModels() {
    const config = await call('/config/providers');
    return { rows: flattenModels(config), defaults: config?.default ?? {} };
  }

  async function assertFreeModel(model) {
    const { rows } = await readModels();
    const match = rows.find((row) => row.providerId === model.providerId && row.modelId === model.modelId);
    if (!match?.free) {
      throw fail(`model "${model.providerId}/${model.modelId}" is not free; only free models are allowed here`, 'model_not_free', 400);
    }
  }

  async function readAgents() {
    const agents = await call('/agent');
    return Array.isArray(agents) ? agents : [];
  }

  async function resolveAgentsDir() {
    if (agentsDir) return agentsDir;
    const paths = await call('/path');
    if (typeof paths?.config !== 'string' || !paths.config) {
      throw fail('OpenCode did not report its config directory', 'backend_unsupported', 501);
    }
    return join(paths.config, 'agents');
  }

  /**
   * The server reads agent files once per instance, so a reload is what makes a
   * write visible. It also drops in-flight work, so refuse while a turn runs
   * rather than interrupt it.
   */
  async function reloadAgents() {
    const busy = await call('/session/status');
    if (busy && typeof busy === 'object' && Object.keys(busy).length > 0) {
      throw fail('OpenCode is running a turn; try again when it finishes', 'backend_busy', 409);
    }
    await call('/global/dispose', { method: 'POST' });
  }

  async function agentFile(id) {
    const dir = await resolveAgentsDir();
    return { dir, path: join(dir, `${id}.md`) };
  }

  async function botAgent(id) {
    const agent = (await readAgents()).find((entry) => entry.name === id);
    return isBotAgent(agent) ? agent : null;
  }

  /**
   * The v2 turn: prompt, then let the experimental wait route declare the
   * turn done. The prompt route takes `{text}` only — the model is a session
   * property, switched explicitly — and there is deliberately no fallback to
   * the v1 blocking POST /message: on v2 that route does not exist, and a
   * "fallback" would only double-submit a turn the server may already be
   * running.
   */
  async function sendMessageV2(sessionId, { text, model, signal } = {}) {
    const session = encodeURIComponent(sessionId);
    const turn = openTurnBus(sessionId, model, signal, 2);
    // The ready wait answers to the caller's signal as well as its own ceiling:
    // a Stop pressed while the subscription is opening is released at once.
    await turn.ready;
    // Nothing has been submitted yet, so a cancelled send is failed here and the
    // session is left alone — there is no turn of ours to stop.
    if (signal?.aborted) {
      turn.close();
      throw turnAbortedError();
    }
    const sentAt = Date.now();
    let submitted = false;
    try {
      if (model?.providerId && model?.modelId) {
        await call(
          `/api/session/${session}/model${locationQuery()}`,
          { method: 'POST', body: JSON.stringify({ model: { providerID: model.providerId, id: model.modelId } }) },
          readTimeoutMs,
          2,
        );
        // The model switch is not the prompt: a Stop that landed while it was
        // in flight ends the send here, before anything is submitted.
        if (signal?.aborted) throw turnAbortedError();
      }
      submitted = true;
      // The prompt carries the caller's signal, so a Stop while the route is
      // still deciding cancels the request itself.
      await postPrompt(
        `/api/session/${session}/prompt${locationQuery()}`,
        JSON.stringify({ text }),
        signal,
        2,
      );
    } catch (error) {
      // v2 has no blocking fallback to double-submit: a cancelled prompt may
      // have been accepted, so the same session is interrupted — bounded, like
      // any Stop — and the send is never repeated.
      if (signal?.aborted && submitted) await stopCancelledSend(sessionId, 2, turn);
      turn.close();
      throw signal?.aborted ? turnAbortedError() : error;
    }
    // The wait route answers 204 exactly when the session goes idle — the
    // completion signal the 2.0.x bus does not emit. Bounded by the turn's
    // own life: settled or closed turns abort it.
    const idleController = new AbortController();
    turn.watchIdle(
      call(
        `/api/experimental/session/${session}/wait${locationQuery()}`,
        { method: 'POST', signal: idleController.signal },
        0,
        2,
      ),
      idleController,
    );
    return turn.wait(sentAt);
  }

  const backend = {
    kind: 'opencode',

    async listSessions() {
      const { major } = await serverProfile();
      if (major >= 2) {
        const payload = await call(`/api/session${locationQuery()}`, {}, readTimeoutMs, 2);
        return (Array.isArray(payload) ? payload : []).map(toGatewaySessionV2);
      }
      const sessions = await call('/session');
      return (Array.isArray(sessions) ? sessions : []).map(toGatewaySession);
    },

    async createSession({ title, model, agent } = {}) {
      const { major } = await serverProfile();
      if (major >= 2) {
        const body = {};
        if (title) body.title = title;
        if (model?.providerId) body.model = { providerID: model.providerId, id: model.modelId };
        const payload = await call(`/api/session${locationQuery()}`, { method: 'POST', body: JSON.stringify(body) }, readTimeoutMs, 2);
        return toGatewaySessionV2(payload);
      }
      const body = {};
      if (title) body.title = title;
      if (agent) body.agent = agent;
      if (model?.providerId) body.model = { providerID: model.providerId, id: model.modelId };
      return toGatewaySession(await call('/session', { method: 'POST', body: JSON.stringify(body) }));
    },

    async deleteSession(sessionId) {
      const { major } = await serverProfile();
      if (major >= 2) {
        await call(`/api/session/${encodeURIComponent(sessionId)}${locationQuery()}`, { method: 'DELETE' }, readTimeoutMs, 2);
        return;
      }
      await call(`/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    },

    async listMessages(sessionId, limit) {
      const { major } = await serverProfile();
      if (major >= 2) {
        const messages = await readMessagesV2(sessionId);
        const mapped = messages.map(toGatewayMessageV2);
        return typeof limit === 'number' ? mapped.slice(-limit) : mapped;
      }
      const messages = await call(`/session/${encodeURIComponent(sessionId)}/message`);
      const mapped = (Array.isArray(messages) ? messages : []).map(toGatewayMessage);
      return typeof limit === 'number' ? mapped.slice(-limit) : mapped;
    },

    /**
     * Submit the turn and complete it from the bus; live deltas come from
     * streamEvents.
     *
     * The bus subscription is opened — and its ready point awaited — before the
     * prompt is posted, so a turn that ends early cannot finish behind the
     * Gate's back. `prompt_async` returns as soon as the server has accepted the
     * turn, so the wait for the answer is bounded here and ends with a reason
     * rather than with a transport timeout. A 404 is the server saying it
     * predates that route, and the blocking POST still serves it.
     *
     * A Stop is not a send. The prompt POST carries the caller's signal; a
     * cancellation before it is posted fails the caller without writing the
     * message, and one that may already have been accepted stops this session
     * through the same bounded route a Stop uses — never by submitting again.
     */
    async sendMessage(sessionId, { text, model, signal, agent } = {}) {
      const { major } = await serverProfile();
      if (major >= 2) return sendMessageV2(sessionId, { text, model, signal });
      const body = { parts: [{ type: 'text', text }] };
      if (agent) body.agent = agent;
      if (model?.providerId) {
        if (freeOnly && agent) await assertFreeModel(model);
        body.model = { providerID: model.providerId, modelID: model.modelId };
      }
      const payload = JSON.stringify(body);
      const session = encodeURIComponent(sessionId);
      // Subscribe first, post second, and record when the send went out: the
      // session's messages are read back against this mark, so the previous
      // turn's answer can never be passed off as this one's.
      const turn = openTurnBus(sessionId, model, signal, 1);
      // The ready wait answers to the caller's signal as well as its own
      // ceiling: a Stop pressed while the subscription is opening is released
      // here at once instead of after the ready window.
      await turn.ready;
      // A cancelled message must never be written into the session. Nothing has
      // been posted yet, so there is no turn to stop: fail the caller and leave
      // the session alone.
      if (signal?.aborted) {
        turn.close();
        throw turnAbortedError();
      }
      const sentAt = Date.now();
      try {
        // The prompt POST carries the caller's signal: a Stop that lands while
        // the route is still deciding cancels the request itself.
        await postPrompt(`/session/${session}/prompt_async`, payload, signal, 1);
      } catch (error) {
        // The acceptance may have reached the server before the cancel did:
        // stop this session, bounded, and report the cancellation. Never fall
        // through to another submission.
        if (signal?.aborted) await stopCancelledSend(sessionId, 1, turn);
        // The bus is not this path's answer: the blocking route is.
        turn.close();
        // Only a missing route falls back: every other refusal may already have
        // been accepted, and re-sending would run the turn twice. The blocking
        // route holds the POST open for the whole turn, so it gets the turn's
        // own silence bound rather than a metadata read's.
        if (error?.status !== 404) throw error;
        // A cancel that arrived with the 404 must not start the blocking send
        // either: that would submit the prompt the operator just cancelled.
        if (signal?.aborted) await stopCancelledSend(sessionId, 1, turn);
        try {
          return turnResult(
            await postPrompt(`/session/${session}/message`, payload, signal, 1, idleMs),
          );
        } catch (fallbackError) {
          // The blocking send was cancelled mid-flight and may still have been
          // accepted: stop the same session and never re-send.
          if (signal?.aborted) await stopCancelledSend(sessionId, 1, turn);
          throw fallbackError;
        }
      }
      return turn.wait(sentAt);
    },

    async abort(sessionId) {
      const { major } = await serverProfile();
      if (major >= 2) {
        await call(`/api/session/${encodeURIComponent(sessionId)}/interrupt${locationQuery()}`, { method: 'POST' }, readTimeoutMs, 2);
        return;
      }
      await call(`/session/${encodeURIComponent(sessionId)}/abort`, { method: 'POST' });
    },

    async replyApproval(sessionId, requestId, reply) {
      const { major } = await serverProfile();
      if (major >= 2) {
        await call(
          `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply${locationQuery()}`,
          { method: 'POST', body: JSON.stringify({ reply }) },
          readTimeoutMs,
          2,
        );
        return;
      }
      await call(
        `/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
        { method: 'POST', body: JSON.stringify({ reply }) },
      );
    },

    /**
     * Every model the CLI can actually reach, qualified by its own provider.
     * A model the catalog has retired is not offered: the server still lists
     * it, but the provider no longer answers for it.
     */
    async listModels() {
      const { major } = await serverProfile();
      if (major >= 2) {
        // v2's GET /api/provider lists only custom providers; the merged
        // catalog (built-ins included) lives on GET /api/model.
        const payload = await call(`/api/model${locationQuery()}`, {}, readTimeoutMs, 2);
        return (Array.isArray(payload) ? payload : []).map((model) => ({
          id: `${model.providerID}/${model.modelID ?? model.id}`,
          providerId: model.providerID,
          modelId: model.modelID ?? model.id,
          label: model.name ?? `${model.providerID}/${model.modelID ?? model.id}`,
          available: model.enabled !== false && model.status !== 'disabled',
        }));
      }
      const config = await call('/config/providers');
      const free = new Map(flattenModels(config).map((row) => [`${row.providerId}/${row.modelId}`, row.free]));
      const models = [];
      for (const provider of config.providers ?? []) {
        for (const [modelId, model] of Object.entries(provider.models ?? {})) {
          if (model?.status === 'deprecated') continue;
          models.push({
            id: `${provider.id}/${modelId}`,
            providerId: provider.id,
            modelId,
            label: `${provider.name ?? provider.id} · ${modelId}`,
            available: true,
            free: free.get(`${provider.id}/${modelId}`) === true,
          });
        }
      }
      return models;
    },

    // ---- Bots: OpenCode agents (ADR 0016) ------------------------------

    async listBots() {
      const agents = await readAgents();
      return { object: 'list', data: agents.filter(isBotAgent).map(toPublicAgentBot) };
    },

    async getBot({ id } = {}) {
      const agent = id ? await botAgent(id) : null;
      if (!agent) throw fail(`unknown bot "${id}"`, 'unknown_bot', 404);
      return { ...toPublicAgentBot(agent), soul: typeof agent.prompt === 'string' ? agent.prompt : '' };
    },

    async createBot({ name, soul, description, modelId, providerId } = {}) {
      const id = validateBotId(name);
      if (!id) throw fail('invalid bot name', 'invalid_bot_name', 400);
      // Any agent of that name — built-in, subagent or Bot — would be shadowed
      // or shadow it, so the name is taken whatever it is.
      if ((await readAgents()).some((entry) => entry.name === id)) {
        throw fail(`bot "${id}" already exists`, 'bot_exists', 409);
      }
      const { rows, defaults } = await readModels();
      const pin = resolveModelPin({ providerId, modelId }, rows, { freeOnly, defaults });
      const { dir, path } = await agentFile(id);
      await ensureDir(dir);
      await writeFile(path, renderAgentFile({ description, soul, ...pin }), { encoding: 'utf8' });
      try {
        await reloadAgents();
      } catch (error) {
        // A Bot that cannot be loaded must not linger as a file that appears
        // later, at a surprising moment, when something else reloads.
        await removeFile(path).catch(() => undefined);
        throw error;
      }
      const created = await botAgent(id);
      if (!created) {
        await removeFile(path).catch(() => undefined);
        throw fail('OpenCode did not load the new agent', 'bot_create_failed', 502);
      }
      return toPublicAgentBot(created);
    },

    /** Fields left absent are untouched; a model pin can be replaced, never cleared (null is ignored). */
    async updateBot({ id, soul, description, modelId, providerId } = {}) {
      const botId = validateBotId(id);
      if (!botId) throw fail('invalid bot name', 'invalid_bot_name', 400);
      const agent = await botAgent(botId);
      if (!agent) throw fail(`unknown bot "${botId}"`, 'unknown_bot', 404);
      const { path } = await agentFile(botId);
      const previous = await readText(path).catch(() => null);
      if (previous === null) {
        // Defined in opencode.json, not as a file the Gate can safely rewrite.
        throw fail(`bot "${botId}" is not defined by an agent file`, 'bot_not_editable', 409);
      }
      let pin = { providerId: agent.model?.providerID, modelId: agent.model?.modelID };
      if (typeof modelId === 'string' && modelId.trim() || typeof providerId === 'string' && providerId.trim()) {
        const { rows, defaults } = await readModels();
        pin = resolveModelPin({ providerId, modelId }, rows, { freeOnly, defaults });
      }
      // A null pin is the app saying "no change": an OpenCode agent always keeps one.
      const next = renderAgentFile({
        description: typeof description === 'string' ? description : agent.description,
        soul: typeof soul === 'string' ? soul : agent.prompt,
        ...pin,
      });
      await writeFile(path, next, { encoding: 'utf8' });
      try {
        await reloadAgents();
      } catch (error) {
        await writeFile(path, previous, { encoding: 'utf8' }).catch(() => undefined);
        throw error;
      }
      return toPublicAgentBot((await botAgent(botId)) ?? agent);
    },

    /**
     * The backend for one Bot: the same server, with every session it opens
     * and every turn it sends carrying the agent, and its roster limited to
     * that agent's own sessions.
     */
    async forBot(botId) {
      const id = validateBotId(botId);
      if (!id || !(await botAgent(id))) throw fail(`unknown bot "${botId}"`, 'unknown_bot', 404);
      return {
        ...backend,
        bot: id,
        async listSessions() {
          return (await backend.listSessions()).filter((session) => session.bot === id);
        },
        async createSession(options = {}) {
          if (freeOnly && options.model?.providerId) await assertFreeModel(options.model);
          return backend.createSession({ ...options, agent: id });
        },
        sendMessage(sessionId, options = {}) {
          return backend.sendMessage(sessionId, { ...options, agent: id });
        },
      };
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
        // Classification first: v2 frames arrive as {id,type,data} and must be
        // translated before any scoping; failure falls back to the legacy v1
        // wire (the legacy tests' stubs answer neither probe).
        const { major } = await serverProfile();
        const metadataLookups = new Map();
        const requestedLookups = new Set();
        const lookupControllers = new Set();
        const lookupTimers = new Set();
        // The cleanup body lives in the try's lexical scope, where the tool map,
        // held text and tracker it must clear are defined. Hoisting a no-op lets
        // a setup failure before those exist still run a safe cleanup.
        let cleanupStreamState = () => {};
        try {
          const response = await fetchImpl(
            major >= 2 ? `${root}/api/event${locationQuery()}` : `${root}/event`,
            {
              signal,
              headers: major >= 2
                ? v2AuthHeaders(password)
                : (password ? { Authorization: `Bearer ${password}` } : {}),
            },
          );
          if (!response.ok) throw new Error(`OpenCode event stream refused: HTTP ${response.status}`);
          reader = response.body?.getReader();
          if (!reader) throw new Error('OpenCode event stream has no body');
          resolveReady();
          const decoder = new TextDecoder();
          let buffer = '';
          const toolCalls = new Map();
          const parts = createOpenCodePartTracker();
          const pendingDeltas = new Map();
          // The role of every message of this turn, from `message.updated`
          // (`info.id` -> `info.role`) or from the bounded message lookup. Only
          // the assistant's text is the answer: the operator's own prompt is a
          // `text` part of a `role:'user'` message on this same session, so
          // without this the reply is published with their words glued in front
          // of it.
          const messageRoles = new Map();
          // Streamed parts held because the role of their message had not
          // arrived yet. Held and released the way an untyped delta is, and
          // dropped outright once the role is known to be another.
          const roleHeld = new Map();
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
            roleHeld.clear();
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
          /**
           * Hold a `field:'text'` delta whose part type has not arrived yet: it
           * could be a thought, and `field` alone cannot say. True when the
           * delta was queued instead of published.
           */
          const holdUntypedDelta = (parsed, recover = true) => {
            if (parsed?.type !== 'message.part.delta') return false;
            const props = parsed.properties ?? {};
            if (props.field !== 'text' || typeof props.delta !== 'string') return false;
            const partId = props.partID;
            if (!partId || parts.partType(partId)) return false;
            const queue = pendingDeltas.get(partId) ?? [];
            queue.push(parsed);
            pendingDeltas.set(partId, queue);
            if (recover) recoverMessageParts(props.messageID);
            return true;
          };
          /**
           * Whether an event would publish answer text at all: a streamed
           * part's snapshot, or one of its deltas.
           */
          const publishesText = (parsed) => {
            if (parsed.type === 'message.part.updated') {
              const part = parsed.properties?.part;
              return Boolean(part && STREAMED_PART_TYPES.has(part.type));
            }
            if (parsed.type !== 'message.part.delta') return false;
            const props = parsed.properties ?? {};
            if (typeof props.delta !== 'string' || !props.delta) return false;
            return props.field === 'text' || props.field === 'reasoning'
              || props.field === 'reasoning_content' || props.field === 'thinking';
          };
          /**
           * Hold a part's text until the role of its message is known. The role
           * arrives on `message.updated`, which the bus does not order before
           * the parts of that message, or from the same bounded message lookup
           * that recovers a part type. True means the caller must not normalize
           * the event: it belongs to a message that is not the assistant's and
           * is dropped, or it is held until the role lands.
           */
          const holdForRole = (parsed) => {
            const props = parsed.properties ?? {};
            const source = parsed.type === 'message.part.updated' ? (props.part ?? {}) : props;
            const messageId = source.messageID ?? props.messageID;
            // Nothing names the message, so nothing can say who wrote it: the
            // legacy shapes the app already maps keep flowing as they did.
            if (!messageId) return false;
            const role = messageRoles.get(messageId);
            if (role === 'assistant') return false;
            if (role !== undefined) return true;
            const key = props.partID ?? source.id ?? messageId;
            const held = roleHeld.get(key) ?? { messageId, events: [] };
            held.events.push(parsed);
            roleHeld.set(key, held);
            recoverMessageParts(messageId);
            return true;
          };
          /**
           * Release the text held for a message whose role has arrived:
           * published when the message is the assistant's, forgotten otherwise
           * so no tail of it can surface later. Releasing every held part (no
           * `messageId`) is what the terminal does once the bound has passed
           * and no role was in sight — the routing the text would have had all
           * along, never a guess.
           */
          const releaseRoleHeld = (messageId, publish) => {
            for (const [key, held] of [...roleHeld]) {
              if (messageId !== undefined && held.messageId !== messageId) continue;
              if (signal?.aborted) return;
              roleHeld.delete(key);
              if (!publish) {
                // The operator's own prompt. A type learned for it is not enough
                // to publish it, so nothing is normalized on its behalf.
                pendingDeltas.delete(key);
                recoveredSnapshots.delete(key);
                continue;
              }
              for (const event of held.events) {
                if (holdUntypedDelta(event, !finished)) continue;
                const flushed = normalizeOpenCodeEvent(event, parts);
                if (flushed) emit(flushed);
              }
              // Only a typed part may leave this way; an untyped one keeps
              // waiting for its metadata exactly as it would have.
              if (parts.partType(key)) flushPartDeltas(key);
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
                let message = await Promise.race([
                  major >= 2
                    ? (async () => {
                        // v2 single-message get: unwrap {data}, then reshape
                        // the message into the v1 envelope ({info, parts})
                        // the checks and tracker below already speak.
                        const raw = await call(
                          `/api/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}${locationQuery()}`,
                          { signal: controller.signal },
                          readTimeoutMs,
                          2,
                        );
                        return toV1MessageEnvelope(raw, sessionId);
                      })()
                    : call(
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
                }
                // The message route carries the role beside the parts, so this
                // lookup answers the role question as well as the type one.
                const role = typeof info?.role === 'string' && info.role ? info.role : undefined;
                if (role) messageRoles.set(messageId, role);
                // A message this answer says nothing about is not a refusal: the
                // held text goes back to the routing it would have had anyway.
                releaseRoleHeld(messageId, role === undefined || role === 'assistant');
                // A message that is not the assistant's has no parts to recover:
                // its text is the operator's prompt and must not be published.
                if (role !== undefined && role !== 'assistant') return;
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
              // v2 wire: every frame is {id,type,data} — translate to the v1
              // event vocabulary before scoping; frames the translator maps
              // away (inbox bookkeeping, redundant usage) return null.
              if (major >= 2) {
                parsed = translateV2Event(parsed);
                if (!parsed) continue;
              }
              // The bus is global; a session's stream must not leak other
              // sessions. Scoping happens here, ahead of every cache the event
              // could reach, so a foreign part cannot share this session's
              // part id and poison the tracker, the pending-delta queues or
              // the tool call map.
              const scoped = scopeToSession(parsed, sessionId);
              if (!scoped) continue;
              parsed = scoped;
              // The role of a message lives only on `message.updated`, and the
              // bus does not promise it lands before the parts of that message.
              if (parsed.type === 'message.updated') {
                const info = parsed.properties?.info;
                if (info?.id && typeof info.role === 'string' && info.role) {
                  messageRoles.set(info.id, info.role);
                  releaseRoleHeld(info.id, info.role === 'assistant');
                }
              }
              // A streamed part's type is metadata about the part, not about its
              // text, so it is remembered even while that text waits for the
              // role below: the type is what decides whether it may be published.
              if (parsed.type === 'message.part.updated') {
                const part = parsed.properties?.part;
                if (part && STREAMED_PART_TYPES.has(part.type)) parts.remember(part);
              }
              // Only the assistant's own text is the answer; the operator's
              // prompt is a `text` part of a `role:'user'` message on this same
              // session. Dropping it here is what stops the prompt echoing in
              // front of the reply.
              if (publishesText(parsed) && holdForRole(parsed)) continue;
              // A streamed part's deltas name it only by id; its type arrives
              // on a separate `message.part.updated`. Hold undecided text
              // deltas until that metadata lands so a thought is never emitted
              // as the answer.
              if (holdUntypedDelta(parsed)) continue;
              // The part's type is known, so whatever waited on it can go.
              if (parsed.type === 'message.part.updated') {
                flushPartDeltas(parsed.properties?.part?.id);
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
                // Text still waiting for its role is reconciled the way text
                // waiting for its type is: the turn is over and the bound has
                // passed, so it goes out by the type it announced, or is
                // reported by id below — never as the answer on a guess.
                releaseRoleHeld(undefined, true);
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

  return backend;
}
