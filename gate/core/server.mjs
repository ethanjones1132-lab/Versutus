import { createServer } from 'node:http';
import { join } from 'node:path';

import { webCors } from './cors.mjs';
import { enableJsonCompression } from './http-compress.mjs';
import { sseHeaders, startSseKeepalive, createSseFrameTracker } from './sse.mjs';
import { loadCapabilities, describeKinds, resolveManifestInstances } from './capabilities/registry.mjs';
import { buildInstanceHandlers } from './capabilities/dispatch.mjs';
import { createRegistryMethods } from './capabilities/registry-methods.mjs';
import { createGatewayMethods } from './capabilities/gateway-methods.mjs';
import { createTerminalSessions } from './cli-environments/terminal.mjs';
import { getSecret } from './capabilities/secrets.mjs';
import { buildManifest } from './manifest.mjs';
import { tailnetIpv4FromInterfaces } from './reachability.mjs';
import { createSerialReload, createDebouncedReload } from './serial-reload.mjs';
import { createSessionIndex, sessionIndexKey } from './session-index.mjs';
import { toGatewaySession } from './cli-environments/backends/hermes.mjs';
import { ProviderStore } from './providers/store.mjs';
import { migrateLegacyProviders } from './providers/migrate-v1.mjs';
import { ProviderService } from './providers/service.mjs';
import { CredentialVault } from './credentials/vault.mjs';
import { createProviderAdapter } from './providers/factory.mjs';
import { createProviderRpc, sanitizeSnapshot } from './providers/rpc.mjs';
import { OAuthManager } from './providers/oauth/refresh.mjs';
import { releaseOAuthProfiles } from './providers/oauth/profiles.mjs';
import { CliEnvironmentStore } from './cli-environments/store.mjs';
import { CliAdapterRegistry } from './cli-environments/adapter-registry.mjs';
import { CliEnvironmentService } from './cli-environments/supervisor.mjs';
import { createEnvironmentRpc, sanitizeEnvironment } from './cli-environments/rpc.mjs';
import { createApprovalRpc } from './approvals/rpc.mjs';
import { createBackendManager } from './cli-environments/backend-manager.mjs';
import { createBotGroupStore, transcriptEntriesForSend } from './cli-environments/bot-groups.mjs';
import { createBackendRunStreams } from './cli-environments/backend-run-streams.mjs';
import { decodeBackendRunHandle, scopeBackendRunResponse, backendRunArchiveKey } from './cli-environments/backend-run-handle.mjs';
import { buildCliEnvironment } from './cli-environments/process-environment.mjs';
import { TokenStore } from './tokens.mjs';
import { PairingStore } from './pairing.mjs';
import { DeviceTokenStore } from './device-tokens.mjs';
import { PushTokenStore } from './push-tokens.mjs';
import { createPushRpc } from './push-rpc.mjs';
import { createPushSend } from './push-send.mjs';
import { createPushNotifier, widgetSnapshot } from './push-notifier.mjs';
import { createVoiceRpc } from './voice/voice-rpc.mjs';
import { attachVoiceMediaSocket } from './voice/media-socket.mjs';
import { createVoiceAudit } from './voice/audit.mjs';
import { LocalEngine } from './voice/engines/local-engine.mjs';
import { voicePaths, voiceStatus, installVoice, uvRunner } from './voice/runtime.mjs';
import { runBackendTurn, modelReport } from './voice/turn-runner.mjs';
import { resolveVoiceBackend, startVoiceBackendLease } from './voice/voice-backend.mjs';
import { ScriptedEngine, scriptedEngineEnabled } from './voice/engines/scripted-engine.mjs';
import { verifySignedAccessRequest, ReplayCache } from './signature.mjs';
import { describeAuthFailure } from './auth-failure.mjs';
import { unresolvedBackendResponse } from './backend-resolution.mjs';
import {
  createBackendModelRouter,
  CATALOGUE_TTL_MS,
  CATALOGUE_STALE_MS,
  CATALOGUE_RESPONSE_TIMEOUT_MS,
  qualifiedModelId,
} from './backend-model-route.mjs';
import { createModelHealth, healthScopeId, modelHealthKey } from './model-health.mjs';
import { isModelFault } from './model-fault.mjs';
import { curateModels } from './model-curation.mjs';
import { backendUpstreamRefusal } from './upstream-refusal.mjs';
import * as openaiFlavor from '../flavors/openai.mjs';
import * as anthropicFlavor from '../flavors/anthropic.mjs';

const FLAVOR_MODULES = { openai: openaiFlavor, anthropic: anthropicFlavor };

// Body size limits (see readJsonBody): the unauthenticated access endpoint
// gets a tight cap — anyone who can reach the port can POST to it — while
// authenticated routes get a generous one, because chat turns can carry
// base64 images.
const ACCESS_MAX_BODY_BYTES = 16 * 1024;
const AUTH_MAX_BODY_BYTES = 64 * 1024 * 1024;

// A phone that names its turn can detach from it: a backgrounded app has its
// socket suspended or killed by Android, which says nothing about the turn
// still running on the Gate. Such a turn is kept alive (see streamBackendTurn)
// and reaped by three bounds, because a turn nobody can see must not be able to
// run forever: an explicit cancel, this age, and this many at a time.
const TURN_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const DEFAULT_DETACHED_TURN_MAX_MS = 10 * 60 * 1000;
const DETACHED_TURN_LIMIT = 8;
// A vendor that accepts the request and never answers would otherwise hold it
// for undici's default forever. This bounds the wait for RESPONSE HEADERS
// only: a slow stream keeps streaming for as long as it is making progress.
const DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS = 120 * 1000;
// Provider states the operator has to fix, not faults a turn ran into: a
// disabled provider, a provider with no key and a stored key this machine
// cannot decrypt are all answered 409, and none of them says anything about
// whether the provider can complete a turn — so none of them is recorded as a
// chat outcome either. Reported as 502 they read as a vendor that was tried and
// failed, and the readiness they wrote was a verdict on a provider nobody asked.
const CONFIGURATION_ERROR_CODES = new Set(['disabled', 'missing_credentials', 'credential_unreadable']);
// How long a burst of chat outcomes is allowed to wait before the manifest is
// rebuilt to match. Injected so the tests do not have to wait a real second.
const DEFAULT_OUTCOME_RELOAD_DELAY_MS = 1000;
// The Gate's own copy of a session list, and the bounds around it
// (session-index.mjs, hermes.mjs). A Hermes list is answered from the copy and
// refilled in the background, because the read it saves is one that measured
// 3-38 s against a 6.2 GB `state.db` on 2026-10-01. A screen waits
// DEFAULT_SESSION_READ_BOUND_MS for that refill — the same 30 s the read bound
// has always been — while the refill itself is given the long bound a cold read
// needs to finish at all, and the copy is refilled once it is older than
// DEFAULT_SESSION_INDEX_STALE_MS. Injected so a test can watch each one fire in
// milliseconds.
const DEFAULT_SESSION_READ_BOUND_MS = 30_000;
const DEFAULT_SESSION_REFRESH_TIMEOUT_MS = 180_000;
const DEFAULT_SESSION_INDEX_STALE_MS = 30_000;
// How long a shutdown waits for the copy's coalesced write to land before it
// stops caring. The write is a small JSON file, so this is only reached by a
// filesystem that has stopped answering.
const DEFAULT_SESSION_INDEX_FLUSH_MS = 2_000;
// What a caller sees when the copy is empty AND the refill is still running.
// The read is not abandoned — it keeps going and fills the copy — so the honest
// answer names that rather than reporting a failure the operator cannot act on.
const SESSION_LIST_SLOW_MESSAGE = 'Hermes is slow to list sessions right now. The Gate is still reading them in the background - try again in a moment.';

/** The caller's turn id, or null when it sent none (or an unusable one). */
function readTurnId(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && TURN_ID_PATTERN.test(raw) ? raw : null;
}

/** What a stream race yields once the client is gone, so `next.done` stays a real result. */
const CLOSED_STREAM = Object.freeze({ closed: true, done: true, value: undefined });

/** The turn to send onward. A native session already holds the history. */
function lastUserText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part) => part?.text ?? '').join('');
  }
  return '';
}

/**
 * Relay a native-environment turn as OpenAI-shaped SSE, through the one turn
 * runner typed and spoken turns share. The runner reports deltas, tool calls
 * and the model that ran; this writer only shapes them onto the wire and adds
 * the empty-turn guarantee.
 *
 * A turn that named itself is detachable. A phone that locks mid-reply has its
 * socket suspended or killed, which is indistinguishable from the user pressing
 * Stop, and reading it as the latter threw the answer away with the reply: no
 * stream, and no notification either, because a dropped turn has no text to
 * report. So a close on a named turn detaches instead of aborting — the turn
 * finishes on the Gate and its reply arrives as a push — while an unnamed turn
 * (every client before this header existed) keeps the old meaning of a close.
 */
async function streamBackendTurn(backend, sessionId, { text, model }, res, {
  callerId = 'anonymous',
  turnId = null,
  inFlightTurns,
  keepaliveIntervalMs,
  detachedTurnMaxMs = DEFAULT_DETACHED_TURN_MAX_MS,
  // How this turn's verdict reaches the model-health table, and under which
  // qualifier (see createGate). Optional: a caller with no table to write
  // passes neither and the turn is scored by nobody.
  recordOutcome,
  healthKey,
} = {}) {
  // One turn per turn id, per caller. The id is how Stop finds this turn, so a
  // second turn claiming an id that is still in use would take the entry with
  // it: the first turn's `finally` would then delete the SECOND turn's entry,
  // leaving it unstoppable, invisible to close() and uncounted against the
  // detached bound. Refused here, before any stream header is written, so the
  // client gets a JSON answer rather than a 200 it would read as a turn.
  const key = turnId && inFlightTurns ? `${callerId}:${turnId}` : null;
  if (key && inFlightTurns.has(key)) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: `Turn "${turnId}" is already running. Send it under a new turn id, or stop that one first.`,
        code: 'turn_id_in_use',
      },
    }));
    return null;
  }

  res.writeHead(200, sseHeaders({
    // The streamed turn is the only chat answer that carries no body to read
    // the session out of, so a phone with no session of its own would open a
    // new one every turn and lose the thread.
    ...(safeHeaderValue(sessionId) ? { 'X-Versutus-Session-Id': sessionId } : {}),
  }));
  const stopKeepalive = startSseKeepalive(res, { intervalMs: keepaliveIntervalMs });

  // A response that closes before we finish is the client walking away (the
  // app's "stop" affordance aborting its fetch, or the network dropping) —
  // not the turn failing. `res.end()` is only ever called from the bottom of
  // this function, so any 'close' observed before that point is premature.
  let clientDisconnected = false;
  res.on('close', () => { clientDisconnected = true; });

  const controller = new AbortController();
  const turn = key
    ? { controller, startedAt: Date.now(), detached: false, finished: false, timer: null }
    : null;
  if (turn) inFlightTurns.set(key, turn);
  res.on('close', () => {
    if (!turn) {
      // A client that walks away must also stop the upstream turn, or the
      // request keeps streaming into a socket nobody is reading.
      controller.abort();
      return;
    }
    // Node emits `close` after `finish` on a normal completion, so a turn that
    // already ran to its end reaches this handler too. A finished turn cannot
    // be detached: its `finally` has cleared the timer and left the map, so
    // arming one here would hold it for the whole age bound with nothing to
    // reap and nothing able to clear it.
    if (turn.finished) return;
    // An explicit cancel already stopped it; the turn is on its way out.
    if (controller.signal.aborted) return;
    // The bound on how many turns may run unseen. Past it a close is read as
    // the stop it used to be: an unbounded set of invisible turns is how a
    // Gate ends up paying for replies nobody will ever read.
    if ([...inFlightTurns.values()].filter((entry) => entry.detached).length >= DETACHED_TURN_LIMIT) {
      controller.abort();
      return;
    }
    turn.detached = true;
    // Writes past here are already suppressed by clientDisconnected, so the
    // turn simply runs to its own conclusion under the age bound.
    turn.timer = setTimeout(
      () => controller.abort(),
      Math.max(0, detachedTurnMaxMs - (Date.now() - turn.startedAt)),
    );
    turn.timer.unref?.();
  });

  // The reply text so far (capped): returned to the caller for the push
  // notifier when the turn completes. A stopped or dropped turn returns null
  // instead — silence, not a "finished" notice for work that never landed.
  let collected = '';
  const collectDelta = (delta) => {
    if (typeof delta !== 'string' || !delta) return;
    if (collected.length >= 2000) return;
    collected += delta.slice(0, 2000 - collected.length);
  };

  try {
    const { hasContent, report, aborted } = await runBackendTurn(backend, sessionId, { text, model }, {
      signal: controller.signal,
      onDelta: collectDelta,
      // Raw OpenAI-shaped payloads, relayed verbatim so a frame the runner
      // cannot read is still forwarded rather than dropped.
      onChunk: (data) => {
        if (!clientDisconnected) res.write(`data: ${data}\n\n`);
      },
    });

    // An aborted turn came back empty BECAUSE it was stopped, and `empty_turn`
    // is the phone's verdict that nothing answered. The runner reports an abort
    // as contentless (turn-runner's ABORTED_OUTCOME), so without this a turn the
    // caller itself ended — Stop, which now cancels over /v1/chat/cancel while
    // the socket is deliberately still open — arrives as "The backend completed
    // the turn with no assistant content.", which the app raises as a
    // streamError before it checks its own abort and shows as "The model did
    // not answer", with advice to pick another model. The caller stopped it, so
    // the only thing left to say is that the stream is over.
    const stopped = aborted === true || controller.signal.aborted;

    // What this turn says about the model. Nothing is recorded for a turn the
    // caller ended or walked away from — Stop, a dropped phone, or the Gate's
    // own bound on an unseen turn are the caller's business, not evidence
    // about the model. A refusal or an empty turn is a failure; an answer
    // clears it.
    if (!stopped && !clientDisconnected) recordOutcome?.(healthKey, { text: collected, hasContent });

    // Same truth the non-streaming path reports: which model actually ran.
    if (!clientDisconnected && report.model) {
      res.write(`data: ${JSON.stringify({ ...report, choices: [] })}\n\n`);
    }

    if (!clientDisconnected && !stopped && !hasContent) {
      // The backend reported the turn as done, but nothing came back that
      // the user could see — a clean [DONE] here would render as a silent
      // empty bubble with no indication anything went wrong.
      res.write(`data: ${JSON.stringify({
        error: { message: 'The backend completed the turn with no assistant content.', code: 'empty_turn' },
      })}\n\n`);
    }
  } catch (error) {
    // Same truth as above, from the other direction: an abort that surfaced as
    // a throw is still the caller's stop, not a backend failure to report.
    if (!clientDisconnected && !controller.signal.aborted) {
      // A throw is where the app's turns actually end: it always streams, so a
      // backend that refuses a turn outright (non-2xx, 429, 5xx, a stall) never
      // reaches the outcome recorded above and would otherwise never be scored.
      recordOutcome?.(healthKey, { reason: error?.message, error });
      const code = typeof error?.code === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(error.code)
        ? error.code : 'backend_error';
      res.write(`data: ${JSON.stringify({ error: { message: error.message, code } })}\n\n`);
    }
  } finally {
    stopKeepalive();
    if (!clientDisconnected) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
    if (turn) {
      turn.finished = true;
      clearTimeout(turn.timer);
      // Only the turn that owns the key may release it: a turn that was
      // replaced under its id (or one that outlived a close() that cleared the
      // map) must not evict the entry its Stop is found through.
      if (inFlightTurns.get(key) === turn) inFlightTurns.delete(key);
    }
  }
  // An aborted turn never earned a notice, however much text it had already
  // streamed: the phone asked it to stop. A detached turn that ran to its end
  // has an answer, and this is the only way that answer can reach the phone.
  return controller.signal.aborted || !collected ? null : collected;
}

/**
 * Whether a value can be written into a response header at all.
 *
 * A session id can arrive from the client, and Node throws ERR_INVALID_CHAR
 * from inside writeHead for a value carrying a newline — an unhandled throw in
 * the middle of opening a stream.
 */
function safeHeaderValue(value) {
  return typeof value === 'string' && /^[\t -~\x80-\xff]{1,512}$/.test(value);
}

/** Backend models are `providerId/modelId`, since a CLI reaches many vendors. */
/**
 * Title for a session this turn has to open.
 *
 * Must be unique. Hermes keeps session titles unique and the backend recovers
 * a refused title by returning the EXISTING session — correct for Bot Chat,
 * which is a Bot's one permanent conversation, and quietly wrong here: the
 * fixed title this used to pass ("Versutus") meant every fresh thread on the
 * Gate was handed back the same session, opened days earlier and pinned for
 * life to whatever model it was born with. Pinning the model at creation
 * cannot help if creation keeps resolving to a session that already exists.
 */
function newThreadTitle() {
  return `Versutus ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`;
}

function parseQualifiedModel(model) {
  const separator = String(model).indexOf('/');
  if (separator === -1) return { modelId: String(model) };
  return { providerId: String(model).slice(0, separator), modelId: String(model).slice(separator + 1) };
}

/**
 * One upstream provider call, owned by the caller's socket and on a clock.
 *
 * Without this the vendor keeps generating (and billing) a turn whose client
 * pressed Stop or lost the network, and a vendor that accepts the connection
 * and never answers holds the request for undici's default instead of being
 * told it timed out. The bound is on the RESPONSE HEADERS only —
 * `clearWatchdog()` runs the moment the response exists, so a long stream is
 * never cut off for being slow, while the client's own abort stays attached for
 * the whole call: a phone that leaves mid-stream is still the reason to stop
 * reading, and undici only tears the connection down if the signal says so.
 */
function providerUpstreamCall(res, { headersTimeoutMs = DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS } = {}) {
  const client = new AbortController();
  res.once('close', () => client.abort());
  const watchdog = new AbortController();
  const timer = setTimeout(() => watchdog.abort(), headersTimeoutMs);
  timer.unref?.();
  return {
    signal: AbortSignal.any([client.signal, watchdog.signal]),
    get clientGone() { return client.signal.aborted; },
    get timedOut() { return watchdog.signal.aborted; },
    clearWatchdog() { clearTimeout(timer); },
  };
}

async function proxyChat(root, provider, requestBody, res, { headersTimeoutMs, keepaliveIntervalMs } = {}) {
  const flavorModule = FLAVOR_MODULES[provider.config.flavor];
  if (!flavorModule) {
    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: `Chat is not implemented for flavor "${provider.config.flavor}"`, code: 'flavor_not_implemented' },
    }));
    return;
  }

  const wantsStream = requestBody.stream === true;
  if (wantsStream && provider.config.streaming === false) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: `Provider "${provider.id}" does not support streaming`, code: 'streaming_unsupported' },
    }));
    return;
  }

  const apiKey = (await getSecret(root, provider.config.apiKeyEnv)) ?? process.env[provider.config.apiKeyEnv] ?? '';
  let upstreamRequest;
  try {
    upstreamRequest = flavorModule.buildChatRequest(provider.config, apiKey, {
      model: requestBody.model,
      messages: requestBody.messages ?? [],
      stream: wantsStream,
    });
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: error.message, code: 'invalid_model' } }));
    return;
  }

  const upstream = providerUpstreamCall(res, { headersTimeoutMs });
  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamRequest.url, { ...upstreamRequest.init, signal: upstream.signal });
  } catch (error) {
    if (upstream.clientGone) return;
    if (upstream.timedOut) {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: 'The provider did not answer within the header timeout.',
          code: 'upstream_timeout',
        },
      }));
      return;
    }
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Upstream request failed: ${error.message}`, code: 'upstream_unreachable' } }));
    return;
  } finally {
    // Headers are in: the stream itself is allowed to take as long as it makes
    // progress, so the clock has done its job.
    upstream.clearWatchdog();
  }

  if (!upstreamResponse.ok) {
    const text = await upstreamResponse.text().catch(() => '');
    res.writeHead(upstreamResponse.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: text || 'Upstream rejected the request', code: 'upstream_error' } }));
    return;
  }

  if (!wantsStream) {
    let json;
    try {
      json = await upstreamResponse.json();
    } catch {
      // The client left, or the body tore: there is nobody left to answer.
      if (upstream.clientGone) return;
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Upstream returned an unreadable body', code: 'upstream_error' } }));
      return;
    }
    const text = flavorModule.parseResponseText(json);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: `gate-${Date.now()}`,
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    }));
    return;
  }

  await relayNormalizedSse(upstreamResponse, flavorModule, res, { upstream, keepaliveIntervalMs });
}

function endProviderStreamWithError(res, error) {
  if (res.destroyed || res.writableEnded) return;
  const message = typeof error?.message === 'string' && error.message.trim()
    ? error.message : 'Provider stream interrupted before completion';
  const code = typeof error?.code === 'string' && error.code
    ? error.code : 'upstream_error';
  // A failed turn ends with its error, never a success-shaped [DONE] marker.
  res.end(`data: ${JSON.stringify({ error: { message, code } })}\n\n`);
}

/**
 * Read an upstream SSE body and re-emit it in the OpenAI delta shape the app's
 * clients parse, whatever dialect the vendor speaks.
 *
 * `upstream` is the caller's abort: when the phone stops or drops, the vendor's
 * stream is cancelled instead of being relayed into a socket nobody reads (and
 * billed to the end).
 *
 * A reasoning model can be silent for a long time before its first token, which
 * is exactly the quiet stream a client would otherwise read as dead, so the
 * heartbeat the headers advertise is really sent here.
 *
 * Resolves with how the turn ENDED, not with the fact that headers were sent:
 * `{ ok: true }` for a stream that reached its end, `{ ok: false, error }` for
 * one that died, `{ abandoned: true }` for a client that walked away. A caller
 * that records the turn has nothing to learn from a stream whose outcome is
 * still open, and the legacy twin ignores the answer entirely.
 */
async function relayNormalizedSse(upstreamResponse, flavorModule, res, { upstream, keepaliveIntervalMs } = {}) {
  res.writeHead(200, sseHeaders());
  const stopKeepalive = startSseKeepalive(res, { intervalMs: keepaliveIntervalMs });

  const reader = upstreamResponse.body.getReader();
  const release = () => reader.cancel().catch(() => {});
  res.once('close', release);
  // Read, not merely listened for: a phone can give up while the vendor is
  // still answering, so the close has already fired by the time we get here and
  // the listener above will never fire.
  const clientGone = () => res.destroyed || res.writableEnded || upstream?.clientGone === true;
  const decoder = new TextDecoder();
  let buffer = '';
  const MAX_BUFFER_BYTES = 1024 * 1024; // 1MB — a single SSE line has no legitimate reason to exceed this
  try {
    while (!clientGone()) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_BUFFER_BYTES) {
        await release();
        const error = Object.assign(
          new Error('Upstream sent an oversized line without a delimiter'),
          { code: 'upstream_error' },
        );
        endProviderStreamWithError(res, error);
        return { ok: false, error };
      }
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        const text = flavorModule.parseDelta(data);
        if (text) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
        }
      }
    }
  } catch (error) {
    // A client that walked away is not a stream failure: there is nothing left
    // to report it to, and the upstream is already being cancelled.
    if (clientGone()) return { abandoned: true };
    endProviderStreamWithError(res, error);
    return { ok: false, error };
  } finally {
    stopKeepalive();
    res.off('close', release);
    await release();
  }
  if (clientGone()) return { abandoned: true };
  res.write('data: [DONE]\n\n');
  res.end();
  return { ok: true };
}

/**
 * The same relay for the other provider shape: an async iterator of
 * already-parsed SSE events instead of a raw response, so there is no reader to
 * cancel and leaving is read off the socket between events. Returns the same
 * three outcomes as `relayNormalizedSse`.
 */
async function relayIteratorSse(events, res, { upstream, keepaliveIntervalMs } = {}) {
  res.writeHead(200, sseHeaders());
  // The same silence a reasoning model produces before its first token, on the
  // path where the local interface hands over an iterator instead of a
  // response: the heartbeat the headers advertise has to be sent here too.
  const stopKeepalive = startSseKeepalive(res, { intervalMs: keepaliveIntervalMs });
  const clientGone = () => res.destroyed || res.writableEnded || upstream?.clientGone === true;
  try {
    for await (const event of events) {
      if (clientGone()) return { abandoned: true };
      const text = typeof event === 'string' ? event : event?.choices?.[0]?.delta?.content;
      if (text) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    }
  } catch (error) {
    // A cancelled turn is the caller's own doing, not a stream failure.
    if (clientGone()) return { abandoned: true };
    endProviderStreamWithError(res, error);
    return { ok: false, error };
  } finally {
    stopKeepalive();
  }
  if (clientGone()) return { abandoned: true };
  res.write('data: [DONE]\n\n');
  res.end();
  return { ok: true };
}

// ─── Voice turn start: resolve a backend truthfully, then run it ─────────
// A spoken turn has two waits before the first byte of a reply: choosing the
// backend for the thread, and the backend's own send. Both are named as stages
// so a call that produces nothing can be placed instead of only being reported
// as "no reply". This module owns the first:
//
//   resolve.start / resolve.ready / resolve.failed — which backend answers,
//     with its descriptor carried into the runner's stages too.
//
// Acceptance is never emitted here: only the runner knows whether a backend
// actually answered. The caller's abort releases the resolve wait at once,
// without waiting for resolution to cooperate — a late resolve must run no
// send, and touch no session, that a newer turn may now own.
const VOICE_TURN_ABORTED = Object.freeze({ hasContent: false, aborted: true });

function voiceBackendDescriptor(backend) {
  if (!backend || typeof backend !== 'object') return 'backend';
  return String(backend.id ?? backend.name ?? backend.adapterId ?? backend.constructor?.name ?? 'backend');
}

function raceVoiceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(VOICE_TURN_ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      resolve(VOICE_TURN_ABORTED);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

/**
 * Resolve which backend answers a spoken turn, naming each stage. Aborting the
 * signal settles the wait without the resolver's cooperation and reports
 * `aborted` so a late resolution never reaches a send.
 *
 * A call brings its own lease (`session.backendLease`): the resolve started when
 * the phone asked for the session, not a new one per turn.
 */
export async function resolveVoiceTurnBackend(backendManager, thread, {
  signal,
  attempt,
  lease = null,
  onStage = () => {},
} = {}) {
  const startedAt = Date.now();
  const meta = attempt === undefined ? {} : { attempt };
  const stage = (name, extra = {}) => {
    try {
      onStage({ stage: name, elapsedMs: Date.now() - startedAt, ...meta, ...extra });
    } catch {
      // Telemetry is a witness, never a failure mode.
    }
  };

  stage('resolve.start');
  let backend;
  try {
    backend = await raceVoiceAbort(
      lease ? lease.backend() : resolveVoiceBackend(backendManager, thread),
      signal,
    );
  } catch (error) {
    stage('resolve.failed', { cause: error?.code ?? error?.name ?? 'resolve_error' });
    throw error;
  }
  if (backend === VOICE_TURN_ABORTED || signal?.aborted) {
    return { backend: null, descriptor: null, aborted: true };
  }
  if (!backend) {
    const error = new Error('No chat backend could answer this call.');
    error.code = 'no_voice_backend';
    stage('resolve.failed', { cause: error.code });
    throw error;
  }
  const descriptor = voiceBackendDescriptor(backend);
  stage('resolve.ready', { backend: descriptor });
  return { backend, descriptor, aborted: false };
}

/** Resolve then run one voice turn, forwarding the backend descriptor. */
export async function runVoiceTurn(backendManager, session, text, handlers = {}) {
  const resolved = await resolveVoiceTurnBackend(backendManager, session?.thread, {
    signal: handlers?.signal,
    attempt: handlers?.attempt,
    // A call resolves once, at `voice.session.start`; anything else resolves
    // per turn as it always has.
    lease: session?.backendLease ?? null,
    onStage: handlers?.onStage,
  });
  if (resolved.aborted) return VOICE_TURN_ABORTED;
  return runBackendTurn(resolved.backend, session?.thread?.sessionId, { text }, {
    ...handlers,
    backendId: resolved.descriptor,
  });
}

/**
 * The Gate's own copy of every backend's session list, under the Gate home.
 *
 * Exported so a test that needs to drive the copy's clock builds it exactly the
 * way the Gate does — including `rowTemplate`, which is what a session the Gate
 * heard about from its own action is stored as: the keys a live Hermes row has,
 * with honest empties for the values nobody has measured. The app reads those
 * keys, and a missing one is not a zero, it is a hole in the list.
 */
export function createGateSessionIndex({ gateHome, now, writeDelayMs } = {}) {
  return createSessionIndex({
    dir: join(gateHome, 'state', 'session-index'),
    ...(now ? { now } : {}),
    ...(writeDelayMs ? { writeDelayMs } : {}),
    rowTemplate: (id) => toGatewaySession({ id, started_at: Date.now(), last_active: Date.now(), preview: '' }),
  });
}

/**
 * Create and configure a Versutus Gate HTTP server
 * @param {Object} config
 * @param {string} config.root - Root directory for the Gate (capabilities and token store location)
 * @param {number} [config.port=0] - Port to listen on (0 = OS chooses)
 * @param {string} [config.name='Versutus Gate'] - Gateway name
 * @param {string} [config.version] - Gateway version
 * @returns {Promise<Object>} Gate object with token, providers, port, listen(), close()
 */
export async function createGate(config = {}) {
  const {
    root,
    port = 0,
    name = 'Versutus Gate',
    version,
    gateHome = process.env.VERSUTUS_GATE_HOME || join(root, '.gate-home'),
    vault: injectedVault,
    environmentRegistry: injectedRegistry,
    backendServerFactory,
    terminalSessions: injectedTerminalSessions,
    pushFetch,
    // Bounds the three things that cannot be inferred from a socket: how long a
    // detached turn may run unseen, how often a silent stream proves it is
    // alive, and how long a vendor may take to send response headers. Injected
    // so the tests can watch each one fire in milliseconds.
    detachedTurnMaxMs = Number(process.env.VERSUTUS_GATE_DETACHED_TURN_MAX_MS) || DEFAULT_DETACHED_TURN_MAX_MS,
    keepaliveIntervalMs,
    upstreamHeadersTimeoutMs = DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS,
    outcomeReloadDelayMs = DEFAULT_OUTCOME_RELOAD_DELAY_MS,
    // The Gate's own copy of every backend's session list. Injected whole so a
    // test can drive its clock and its bounds; the three below are the bounds
    // a screen waits, a refill is given, and a copy goes stale after.
    sessionIndex,
    sessionReadBoundMs = DEFAULT_SESSION_READ_BOUND_MS,
    sessionRefreshTimeoutMs = DEFAULT_SESSION_REFRESH_TIMEOUT_MS,
    sessionIndexStaleMs = DEFAULT_SESSION_INDEX_STALE_MS,
    // The two catalogue-cache windows, injected so the tests can watch the
    // stale-while-refresh answer fire in milliseconds instead of waiting a
    // minute for the live one.
    catalogueTtlMs = CATALOGUE_TTL_MS,
    catalogueStaleMs = CATALOGUE_STALE_MS,
    // The bound on a `/v1/models` cold read, separate from the routing lookup's
    // 5 s because one Hermes `/api/model/options` measures 3.9 s on the live
    // host. Injected with the two windows above for the same reason.
    catalogueResponseTimeoutMs = CATALOGUE_RESPONSE_TIMEOUT_MS,
    modelHealthFile = join(gateHome, 'model-health.json'),
  } = config;

  await migrateLegacyProviders({ sourceRoot: root, gateHome });
  /**
   * Turns running on this Gate, keyed `${callerId}:${turnId}`.
   *
   * Caller-scoped so one phone's Stop can never abort another's turn, and owned
   * by this Gate instance so two of them in one process cannot abort each
   * other's turns or share the detached-turn bound. A turn registers here before
   * the first byte of upstream work and leaves in streamBackendTurn's `finally`;
   * close() aborts whatever is left.
   */
  const inFlightTurns = new Map();
  const providerStore = new ProviderStore(gateHome);
  const vault = injectedVault ?? new CredentialVault({ gateHome });
  const oauth = new OAuthManager({ vault, profiles: releaseOAuthProfiles });
  const providerService = new ProviderService({
    store: providerStore,
    vault,
    createAdapter: (registration) => createProviderAdapter(registration, { vault, store: providerStore }),
  });
  const providerRpc = createProviderRpc({
    service: providerService,
    vault,
    oauth,
    // The manifest advertises providers, so a newly registered one must be
    // visible without restarting the Gate.
    onChanged: () => reload(),
  });
  const environmentStore = new CliEnvironmentStore(gateHome);
  // Group membership writes cross-check the same roster the Bots screen
  // reads, so a typo'd or stale bot id dies at the door (400 naming it)
  // instead of surviving until the room's first message fails wholesale.
  // Walked capability-first like resolveBackendFor, but response-free: the
  // store turns an unreachable roster into its own honest refusal. The
  // backendManager binding is declared below; resolution happens per write,
  // long after setup finishes.
  const botGroups = createBotGroupStore(gateHome, {
    listBotIds: async () => {
      for (const entry of await backendManager.list()) {
        if (!await backendCanServe(entry, 'listBots')) continue;
        const backend = await backendManager.get(entry.id).catch(() => null);
        if (backend && typeof backend.listBots === 'function') {
          // listBots speaks the wire shape ({ object: 'list', data: [...] });
          // a bare array is accepted too, but never guessed from anything else.
          const roster = await backend.listBots();
          const rows = Array.isArray(roster) ? roster : Array.isArray(roster?.data) ? roster.data : [];
          return rows.map((bot) => String(bot?.id ?? '')).filter(Boolean);
        }
      }
      throw new Error('no attached backend can list bots');
    },
  });
  // Live Hermes-kind run streams are teed here so a finished run still
  // replays after Hermes drops its live-only event buffer — and across a
  // Gate restart. Separate from the environments archive (<gateHome>/runs):
  // that one is JSONL keyed by environment, this one is raw SSE bytes keyed
  // by run id.
  const runStreams = createBackendRunStreams(join(gateHome, 'run-streams'));
  // Gate-owned, like the run streams: a Hermes session list is answered from
  // this copy and refilled in the background, so Hermes's own data is never
  // written to and its state.db is never opened. Under <gateHome>/state, apart
  // from the other config, because it is state rather than a registration.
  const sessionListIndex = sessionIndex ?? createGateSessionIndex({ gateHome });
  const environmentRegistry = injectedRegistry ?? new CliAdapterRegistry();
  const environmentService = new CliEnvironmentService({
    store: environmentStore,
    registry: environmentRegistry,
    // Bound credential references resolve into the CLI's environment at run
    // start — same vault the providers and backend-manager read.
    vault,
    // Run history outlives the process: every event is appended under
    // <gateHome>/runs, and init() (below, before listen) reloads finished
    // runs at startup so Recent runs + replay survive a Gate restart.
    archiveDir: join(gateHome, 'runs'),
  });
  const environmentRpc = createEnvironmentRpc({
    store: environmentStore,
    service: environmentService,
    registry: environmentRegistry,
    // The manifest advertises backends and the capabilities they provide, so a
    // newly attached CLI must be visible without restarting the Gate.
    onChanged: () => reload(),
  });

  // D1: the pending-approval list the CLI environment supervisor already holds,
  // over RPC, so a paired phone can triage an approval it did not open the run
  // for. The class and summary are the supervisor's own; the inbox adds none.
  const approvalRpc = createApprovalRpc({ approvals: environmentService.approvals });

  // Environments that expose a native server become chat backends: they own
  // their own sessions, models and tools, and the Gate proxies to them rather
  // than reimplementing any of it.
  const backendManager = createBackendManager({
    store: environmentStore,
    registry: environmentRegistry,
    vault,
    environmentState: environmentService.environmentState,
    buildEnvironment: async ({ record, credentials }) =>
      buildCliEnvironment(process.env, {
        environmentId: record.id,
        runId: `serve-${record.id}`,
        endpoints: { chat: `http://127.0.0.1:${gateObj?.port ?? port}/v1/chat/completions` },
        credentials,
      }),
    createServer: backendServerFactory,
  });

  /**
   * Whether an environment's backend could serve `method`, answered without
   * starting it.
   *
   * `get()` starts the environment's native server, so a walk that started every
   * attached backend in order to ask whether it implements one method
   * cold-started Codex and opencode on the first roster, skills or jobs read
   * after a Gate restart — only to learn it does not. A `null` verdict means the
   * answer is unknown, and unknown keeps the old behaviour: start it and let the
   * method check decide.
   */
  async function backendCanServe(entry, method) {
    const methods = await backendManager.methodsOf(entry.id);
    return methods === null || methods.has(method);
  }

  /**
   * Which attached environment serves a model, for a turn that named a provider
   * this Gate does not own (see core/backend-model-route.mjs).
   *
   * Only ever asked for such a turn: an id the Gate holds a record for is that
   * provider's turn to answer, and the app now sends this thread's environment
   * with every turn. Catalogs are cached per environment for a minute, so the
   * burst of turns a retry storm produces costs one read each. `/v1/models`
   * reads the same cache, so opening the picker warms the routing lookup too.
   */
  const modelRouter = createBackendModelRouter({
    listBackends: () => backendManager.list(),
    listModels: async (entry) => {
      const backend = await backendManager.get(entry.id);
      return backend.listModels();
    },
    ttlMs: catalogueTtlMs,
    staleMs: catalogueStaleMs,
    responseTimeoutMs: catalogueResponseTimeoutMs,
  });

  /**
   * How the models on this host have actually behaved. Judged from real turns
   * only — a catalogue says what an environment claims to serve, and two
   * refused turns say whether it can (see core/model-health.mjs).
   */
  const modelHealth = createModelHealth({ file: modelHealthFile });

  /**
   * One turn's verdict, as the catalogue reads it: an upstream refusal or a
   * turn that completed with nothing to show is a failure, an answer clears
   * the model, and a turn the caller stopped — or that failed on a bug in this
   * Gate — says nothing at all about it (see core/model-fault.mjs).
   */
  function recordTurnOutcome(key, { text = '', hasContent = false, reason = '', error = null } = {}) {
    if (!key) return;
    const refusal = backendUpstreamRefusal(text);
    if (refusal) {
      modelHealth.recordFailure(key, refusal);
      return;
    }
    if (error !== undefined && error !== null) {
      // A throw is evidence about the model only when the model or its provider
      // produced it. Scored as a failure, a defect in the Gate hides the
      // operator's models for six hours and nothing in the picker says why
      // (2026-10-02); scored as a success it would clear a verdict the model
      // really earned. So it records nothing.
      if (isModelFault(error)) modelHealth.recordFailure(key, reason || String(error));
      return;
    }
    if (hasContent) modelHealth.recordSuccess(key);
    else modelHealth.recordFailure(key, reason || 'the backend completed the turn with no assistant content');
  }

  // Shell sessions for the app's Shell tab. See terminal.mjs for why this is a
  // piped shell rather than a PTY — it is what this client actually consumes.
  const terminalSessions = injectedTerminalSessions ?? createTerminalSessions();
  // Open SSE responses, tracked so shutdown can end them. `server.close()`
  // waits for in-flight connections, and a terminal stream never finishes on
  // its own — without this a Gate with the Shell tab open cannot shut down.
  const terminalStreams = new Set();

  const tokenPath = join(root, '.tokens.json');

  // Live, mutable capability state. Recomputed by reload() after any
  // registry.instances.* mutation, so a new/edited/deleted instance is
  // reflected in routing, the manifest, and the RPC dispatch table without
  // restarting the Gate.
  /**
   * RPC method tables.
   *
   * Declared above `computeState()` because the manifest advertises their
   * names (`rpcMethods`), and a manifest built before they exist would ship an
   * empty list — which reads to the app as "this gateway dispatches nothing".
   * Both close over `state`/`reload` lazily, so the order is safe.
   */
  const registryMethods = {
    ...createRegistryMethods({ root, getState: () => state, reload: () => reload(), gateHome }),
    ...providerRpc,
    ...environmentRpc,
  };

  // Device tokens are Gate-owned, not a backend's. The store is created here
  // so `device.list` is on gatewayMethods before computeState advertises
  // rpcMethods — a method added after that first build would be dispatchable
  // but invisible until the next reload.
  const deviceTokens = new DeviceTokenStore(join(root, '.device-tokens.json'));
  const pushTokens = new PushTokenStore(join(gateHome, 'push-tokens.json'));
  const pushSend = createPushSend({ fetchImpl: pushFetch ?? globalThis.fetch });
  const notificationMethods = createPushRpc({ tokens: pushTokens, send: pushSend.send });
  // Solution A — true push: runs, approvals, replies and routines report
  // here. The widget companion reads the same live state the manifest does.
  const pushNotifier = createPushNotifier({
    tokens: pushTokens,
    send: pushSend.send,
    collectReceipts: pushSend.collectReceipts,
    snapshot: () => {
      // Runs, not environments: the card words this as "N runs in flight".
      const busyRuns = environmentService.liveRunCount();
      const pending = environmentService.approvals && typeof environmentService.approvals.list === 'function'
        ? environmentService.approvals.list().length
        : 0;
      return widgetSnapshot({ busyRuns, approvalsPending: pending });
    },
  });
  // Best-effort by design: a push failure must never break the Gate turn,
  // run or approval it reports on.
  const notifyPush = (event) => {
    try {
      pushNotifier.notify(event)?.catch?.(() => {});
    } catch {
      // The notifier already swallows observer faults; this guards sync throws.
    }
  };
  // A chat Session earns one notification per completed turn, and two replies
  // can read the same. The notifier keys a chat reply on the turn id this
  // seam attaches; a per-session sequence keeps it strictly per-turn, so a
  // replay of the same turn's event still collapses while a later turn with
  // identical text still notifies.
  const turnSeqs = new Map();
  function nextTurnId(sessionId) {
    const seq = (turnSeqs.get(sessionId) ?? 0) + 1;
    turnSeqs.set(sessionId, seq);
    return `turn-${seq}`;
  }
  environmentService.onRunEvent = notifyPush;
  // Voice sessions live on the Gate; the media socket (M2 task 2.2) reads the
  // same registry the RPC writes, so a grant and its socket cannot disagree.
  // Capabilities are read from the installed runtime (M5 task 5.2): `local` is
  // `ready` only once the venv and models are on disk, so `auto` cannot pick an
  // engine that is not there.
  const voiceRpc = createVoiceRpc({
    log: (line) => console.log(line),
    capabilities: () => voiceStatus({ paths: voicePaths() }),
    install: {
      // The phone starts the same install the CLI runs, over the same runtime.
      start: () =>
        installVoice({
          paths: voicePaths(),
          runUv: uvRunner(),
          fetch: globalThis.fetch,
          log: () => {},
        }),
      status: () => voiceStatus({ paths: voicePaths() }).engines.local,
    },
    // One resolve per call: the backend that will answer is chosen when the
    // phone asks for the session, not when it first speaks, and every turn of
    // the call takes that one answer.
    prepareCallBackend: ({ thread }) => startVoiceBackendLease(backendManager, thread),
  });

  // The Hermes-dialect methods the app's command registry actually sends.
  // Resolution throws rather than writing a response: the RPC dispatcher below
  // owns the reply shape, unlike the REST routes' `resolveBackend`.
  const gatewayMethods = {
    ...createGatewayMethods({
      listDevices: () => deviceTokens.list(),
      revokeDevice: async (deviceId) => {
        const revoked = await deviceTokens.revoke(deviceId);
        if (revoked) await pushTokens.remove(deviceId);
        return revoked;
      },
      async getBackend(backendId, method) {
        if (backendId) return backendManager.get(backendId);
        const entries = await backendManager.list();
        // Same rule as the REST routes: prefer a backend that can answer, rather
        // than whichever happens to be attached first.
        if (method) {
          for (const entry of entries) {
            if (!await backendCanServe(entry, method)) continue;
            const backend = await backendManager.get(entry.id).catch(() => null);
            if (backend && typeof backend[method] === 'function') return backend;
          }
        }
        const id = entries[0]?.id;
        if (!id) throw new Error('No chat backend is attached to this Gate');
        return backendManager.get(id);
      },
    }),
    ...notificationMethods,
    ...voiceRpc.methods,
    ...approvalRpc.methods,
  };

  // Resolve the backend that answers a spoken turn the same way a typed turn
  // does: a named Bot owns its environment, an explicit backendId wins, and no
  // Bot means the first attached backend. Returns null instead of writing an
  // HTTP response, because a voice turn has none.

  async function computeState() {
    const { kinds, instances } = await loadCapabilities(root);
    const providers = instances
      .filter((instance) => instance.kind === 'provider')
      .map((instance) => ({ id: instance.id, label: instance.label, config: instance.config }));
    // Sessions and tools are only advertised because a backend actually
    // provides them; a Gate with no environment attached must not claim either.
    const backends = await backendManager.describe().catch(() => []);
    // v2 providers live under Gate home and are owned by ProviderService, so
    // loadCapabilities(root) — which only reads the legacy registry — cannot
    // see them. A failure here must not take the manifest down.
    const providerSnapshots = await providerService.list().catch(() => []);
    // Built before the manifest so its keys can be advertised: a capability
    // instance that contributes methods must appear in `rpcMethods` on the
    // same reload that registers it, not on the next restart.
    const dispatch = buildInstanceHandlers(kinds, instances);
    const manifest = buildManifest({
      name,
      version,
      backends,
      providerSnapshots,
      capabilityKinds: describeKinds(kinds),
      capabilityInstances: resolveManifestInstances(kinds, instances),
      rpcMethods: [...new Set([
        ...Object.keys(registryMethods),
        ...Object.keys(gatewayMethods),
        ...dispatch.keys(),
      ])].sort(),
      ipv4: tailnetIpv4FromInterfaces(),
    });
    return { kinds, instances, providers, manifest, dispatch };
  }

  // Assigning a whole snapshot is only safe while the snapshots arrive in the
  // order their reads did: two RPC surfaces reload this same state, and an older
  // read that finished last used to hide a provider or an instance that had
  // already been created. See `createSerialReload`.
  let state = await computeState();
  const reload = createSerialReload(async () => {
    const next = await computeState();
    state = next;
    return next;
  });
  // The manifest advertises readiness, and readiness is only as good as the last
  // real turn — so a turn that moved the verdict has to be able to move it.
  // Debounced because turns arrive in bursts and a phone retrying would
  // otherwise rebuild the whole state once per attempt.
  const scheduleOutcomeReload = createDebouncedReload(
    () => reload().catch(() => undefined),
    { delayMs: outcomeReloadDelayMs },
  );

  /**
   * Whether the Gate itself owns this provider id — a v2 store record or a
   * legacy registry entry, the same two sources `dispatchChat` resolves.
   *
   * Asked before a scope-less turn is routed to an environment: a provider the
   * Gate holds is that vendor's turn, and an environment that happens to list
   * the same string is a coincidence this route must not act on.
   */
  async function gateOwnsProvider(providerId) {
    if (!providerId) return false;
    const record = await providerStore.get(providerId).catch(() => null);
    return Boolean(record) || state.providers.some((item) => item.id === providerId);
  }

  /**
   * Send a chat request to whichever component actually owns the provider's
   * credentials.
   *
   * `migrateLegacyProviders` copies `registry/<id>.json` into the v2 store but
   * leaves the original file in place, so `loadCapabilities` keeps surfacing a
   * legacy twin under the same id forever. That twin must never win: the flavor
   * codecs deliberately emit no auth header (auth moved into provider profiles
   * — see gate/flavors/openai.mjs), and its `apiKeyEnv`/static `models[]` are
   * the stale bootstrap values. Routing a migrated provider through proxyChat
   * reaches the vendor unauthenticated and rejects every model discovered since.
   */
  async function dispatchChat(providerId, body, res) {
    const record = await providerStore.get(providerId);
    const legacy = state.providers.find((item) => item.id === providerId);

    if (!record && !legacy) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Unknown provider "${providerId}"`, code: 'unknown_provider' } }));
      return;
    }

    // `streaming: false` is declared on the registry record and has no v2
    // equivalent yet, so the twin stays authoritative for that one capability.
    if (body.stream === true && legacy?.config.streaming === false) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: { message: `Provider "${providerId}" does not support streaming`, code: 'streaming_unsupported' },
      }));
      return;
    }

    if (record) {
      await chatViaProviderService(providerId, record, body, res);
      return;
    }
    await proxyChat(root, legacy, body, res, { headersTimeoutMs: upstreamHeadersTimeoutMs, keepaliveIntervalMs });
  }

  /**
   * Record how a turn really went, and let the manifest follow when it moved the
   * verdict. A streamed turn is only ever recorded from the relay's answer, once
   * the final frame is written, so the store write is the only thing left between
   * the client and the handler settling and `end()` never waits for it. A failure
   * here is swallowed: the turn has already been answered, and a store that
   * cannot record it is not the phone's problem.
   */
  async function noteTurnOutcome(providerId, error) {
    const outcome = await providerService.noteChatOutcome(providerId, error).catch(() => undefined);
    if (outcome?.changed) scheduleOutcomeReload();
  }

  /** Chat through the v2 ProviderService, which resolves the vault credential. */
  async function chatViaProviderService(providerId, record, body, res) {
    const wantsStream = body.stream === true;
    const flavorModule =
      record.config?.registration?.protocol === 'anthropic_messages' ? anthropicFlavor : openaiFlavor;

    // The adapter threads this into its own fetch, so a Stop or a dropped
    // connection ends the vendor's turn instead of leaving it to finish.
    const upstream = providerUpstreamCall(res, { headersTimeoutMs: upstreamHeadersTimeoutMs });
    let result;
    try {
      result = await providerService.chat({
        providerId,
        model: body.model,
        messages: body.messages ?? [],
        stream: wantsStream,
      }, upstream.signal);
    } catch (error) {
      if (upstream.clientGone) return;
      if (upstream.timedOut) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: { message: 'The provider did not answer within the header timeout.', code: 'upstream_timeout' },
        }));
        return;
      }
      // A configuration state is not a verdict on the provider: nothing was
      // asked of it, so nothing it answered says whether it can complete a turn.
      const configured = CONFIGURATION_ERROR_CODES.has(error.code);
      // Readiness is only as good as its last real turn: a catalog probe passes
      // on a provider whose account cannot pay for a completion.
      if (!configured) await noteTurnOutcome(providerId, error);
      const status = configured
        ? 409
        : Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
          ? error.status
          : 502;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message, code: error.code || 'upstream_error' } }));
      return;
    } finally {
      // Headers (or the whole answer) are in: a slow stream is not a timeout.
      upstream.clearWatchdog();
    }

    // A streamed turn is not decided at its headers. Headers only say the
    // vendor accepted the request: the relay reports how it ENDED, and until it
    // does there is nothing honest to record. So the answer, the frames and the
    // record all come from the same run — which is the only way a vendor whose
    // stream dies mid-reply stops being advertised as ready.
    if (!wantsStream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: `gate-${Date.now()}`,
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: flavorModule.parseResponseText(result) },
          finish_reason: 'stop',
        }],
      }));
      await noteTurnOutcome(providerId, null);
      return;
    }

    // Profile adapters hand back the raw upstream Response; the local-interface
    // adapter hands back an async iterator of already-parsed SSE events.
    const outcome = typeof result?.body?.getReader === 'function'
      ? await relayNormalizedSse(result, flavorModule, res, { upstream, keepaliveIntervalMs })
      : await relayIteratorSse(result, res, { upstream, keepaliveIntervalMs });
    // A turn the client stopped is not a failure and not a success: it says
    // nothing about the provider, so nothing is written for it.
    if (outcome?.ok) await noteTurnOutcome(providerId, null);
    else if (outcome?.error) await noteTurnOutcome(providerId, outcome.error);
  }

  // Initialize token store
  const tokenStore = new TokenStore(tokenPath);
  const token = await tokenStore.ensureToken();

  const pairing = new PairingStore(join(root, '.pairing.json'));
  const replayCache = new ReplayCache();

  // Create HTTP server
  const server = createServer(async (req, res) => {
    // Web CORS: opt-in via --allow-origin / VERSUTUS_GATE_ALLOW_ORIGIN. Until
    // the operator names origins this handles nothing at all (core/cors.mjs).
    if (webCors(req, res)) return;

    // One-shot JSON answers go out gzipped for the clients that ask; streams and
    // small answers are handed straight back to node:http (core/http-compress.mjs).
    enableJsonCompression(req, res);

    // Set common headers
    res.setHeader('Content-Type', 'application/json');

    // Parse URL and method
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method;

    const invalidJsonBody = new Error('Request body must be valid JSON');
    const bodyTooLarge = new Error('Request body is too large');
    // Count bytes as they arrive and stop at the limit: an unauthenticated
    // caller must never be able to exhaust memory (or disk) by streaming a
    // body no route could ever use.
    async function readJsonBody(req, { maxBytes } = {}) {
      const chunks = [];
      let total = 0;
      let exceeded = false;
      for await (const chunk of req) {
        total += chunk.length;
        if (maxBytes !== undefined && total > maxBytes) {
          exceeded = true;
          break;
        }
        chunks.push(chunk);
      }
      if (exceeded) {
        throw bodyTooLarge;
      }
      const text = Buffer.concat(chunks).toString('utf8');
      // Bodyless Routine actions are valid; nonempty invalid JSON is not.
      if (text.length === 0) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw invalidJsonBody;
      }
    }

    try {
      // Health endpoint (unauthenticated). Also served under each provider
      // base path so a child profile whose baseUrl is /p/{id} can probe
      // relative /health successfully.
      const healthMatch = pathname === '/health' || /^\/p\/[^/]+\/health$/.test(pathname);
      if (healthMatch && method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({
          status: 'ok',
          timestamp: new Date().toISOString(),
        }));
        return;
      }

      // Manifest endpoint (unauthenticated)
      if (pathname === '/.well-known/gateway.json' && method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify(state.manifest));
        return;
      }

      // Pairing/access endpoint (unauthenticated). The tight limit is the
      // point: this route is reachable by anyone who can hit the port, and a
      // signed access request is a few hundred bytes.
      if (pathname === '/.well-known/gateway/access' && method === 'POST') {
        const body = await readJsonBody(req, { maxBytes: ACCESS_MAX_BODY_BYTES });
        const device = body?.device;
        if (!body || !device?.id || !device?.publicKey || !body.signature || typeof body.signedAtMs !== 'number') {
          res.writeHead(400);
          res.end(JSON.stringify({ status: 'denied', reason: 'Malformed access request.' }));
          return;
        }

        const verification = verifySignedAccessRequest(
          {
            deviceId: device.id,
            publicKeyB64Url: device.publicKey,
            clientId: device.clientId,
            role: body.role ?? 'operator',
            scopes: Array.isArray(body.scopes) ? body.scopes : [],
            signedAtMs: body.signedAtMs,
            signature: body.signature,
          },
          { replayCache },
        );

        if (!verification.ok) {
          res.writeHead(403);
          res.end(JSON.stringify({ status: 'denied', reason: verification.reason }));
          return;
        }

        const existing = await deviceTokens.list();
        const already = existing.find((entry) => entry.deviceId === device.id && !entry.revoked);
        if (already) {
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'granted', token: already.token, role: already.role, scopes: already.scopes }));
          return;
        }

        const role = body.role ?? 'operator';
        const scopes = Array.isArray(body.scopes) ? body.scopes : [];

        if (await pairing.isWindowOpen()) {
          const grantedToken = await deviceTokens.issue(device.id, { role, scopes });
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'granted', token: grantedToken, role, scopes }));
          return;
        }

        const requestId = await pairing.addPending({
          deviceId: device.id,
          publicKeyB64Url: device.publicKey,
          clientId: device.clientId,
          role,
          scopes,
        });
        res.writeHead(202);
        res.end(JSON.stringify({ status: 'pending', requestId }));
        return;
      }

      // Check if route exists before requiring authentication
      // This allows us to return 404 for unknown routes
      const isKnownAuthenticatedRoute =
        (pathname === '/v1/models' && method === 'GET') ||
        (pathname === '/v1/providers' && method === 'GET') ||
        /^\/v1\/providers\/[^/]+$/.test(pathname) ||
        /^\/p\/[^/]+\/v1\/models$/.test(pathname) ||
        (pathname === '/v1/chat/completions' && method === 'POST') ||
        (pathname === '/v1/chat/cancel' && method === 'POST') ||
        /^\/p\/[^/]+\/v1\/chat\/completions$/.test(pathname) ||
        (pathname === '/v1/backends' && method === 'GET') ||
        (pathname === '/v1/toolsets' && method === 'GET') ||
        (pathname === '/v1/terminal/stream' && method === 'GET') ||
        (pathname === '/v1/terminal/input' && method === 'POST') ||
        (pathname === '/v1/skills' && method === 'GET') ||
        (pathname === '/v1/bots' && method === 'GET') ||
        (pathname === '/v1/bots' && method === 'POST') ||
        (method === 'GET' && /^\/v1\/bots\/[^/]+$/.test(pathname)) ||
        (method === 'PATCH' && /^\/v1\/bots\/[^/]+$/.test(pathname)) ||
        (pathname === '/v1/bots/handoff' && method === 'POST') ||
        (pathname === '/v1/bot-groups' && (method === 'GET' || method === 'POST')) ||
        /^\/v1\/bot-groups\/[^/]+\/messages$/.test(pathname) ||
        /^\/v1\/bot-groups\/[^/]+\/leave$/.test(pathname) ||
        (method === 'PATCH' && /^\/v1\/bot-groups\/[^/]+$/.test(pathname)) ||
        (method === 'DELETE' && /^\/v1\/bot-groups\/[^/]+$/.test(pathname)) ||
        // Note the divergence from plain /health, which is unauthenticated:
        // detailed diagnostics expose backend internals and need a token.
        (pathname === '/health/detailed' && method === 'GET') ||
        (pathname === '/v1/jobs' && (method === 'GET' || method === 'POST')) ||
        /^\/v1\/jobs\/[^/]+\/(run|pause|resume)$/.test(pathname) ||
        (method === 'DELETE' && /^\/v1\/jobs\/[^/]+$/.test(pathname)) ||
        (pathname === '/v1/sessions' && (method === 'GET' || method === 'POST')) ||
        /^\/v1\/sessions\/[^/]+$/.test(pathname) ||
        /^\/v1\/sessions\/[^/]+\/messages$/.test(pathname) ||
        (pathname === '/v1/environments' && method === 'GET') ||
        /^\/v1\/environments\/[^/]+\/runs$/.test(pathname) ||
        /^\/v1\/environments\/[^/]+\/runs\/[^/]+\/events$/.test(pathname) ||
        /^\/v1\/environments\/[^/]+\/runs\/[^/]+\/cancel$/.test(pathname) ||
        /^\/v1\/environments\/[^/]+\/runs\/[^/]+\/approve$/.test(pathname) ||
        (pathname === '/v1/runs' && method === 'POST') ||
        /^\/v1\/runs\/[^/]+$/.test(pathname) ||
        /^\/v1\/runs\/[^/]+\/(events|stop|approval|steer)$/.test(pathname) ||
        (pathname === '/v1/capabilities/rpc' && method === 'POST') ||
        /^\/p\/[^/]+\/v1\/capabilities\/rpc$/.test(pathname);

      if (!isKnownAuthenticatedRoute) {
        // Unknown route - return 404
        res.writeHead(404);
        res.end(JSON.stringify({
          error: 'Not Found',
          message: `${method} ${pathname} not found`,
        }));
        return;
      }

      // All authenticated endpoints require authentication
      const authHeader = req.headers.authorization;
      // The device grant is kept, not just counted: it is the only caller
      // identity the Gate has, and terminal sessions are bound to it.
      const deviceGrant = await deviceTokens.verify(authHeader);
      const isAuthenticated = (await tokenStore.verify(authHeader)) || Boolean(deviceGrant);
      const callerId = deviceGrant?.deviceId ?? 'bootstrap-token';

      if (!isAuthenticated) {
        // The log is the only place a refusal can be diagnosed from; the line
        // names the credential's shape, never its value (auth-failure.mjs).
        console.warn(describeAuthFailure({
          method,
          pathname,
          authorization: authHeader,
          remoteAddress: req.socket.remoteAddress,
        }));
        res.writeHead(401);
        res.end(JSON.stringify({
          error: 'Unauthorized',
          message: 'Bearer token required',
        }));
        return;
      }

      // Authenticated endpoints

      if (pathname === '/v1/providers' && method === 'GET') {
        const snapshots = await providerService.list();
        res.writeHead(200);
        res.end(JSON.stringify({ providers: snapshots.map(sanitizeSnapshot) }));
        return;
      }

      const providerMatch = pathname.match(/^\/v1\/providers\/([^/]+)$/);
      if (providerMatch && method === 'GET') {
        try {
          const snapshot = await providerService.get(decodeURIComponent(providerMatch[1]));
          res.writeHead(200);
          res.end(JSON.stringify(sanitizeSnapshot(snapshot)));
        } catch {
          res.writeHead(404);
          res.end(JSON.stringify({ error: { message: 'provider not found', code: 'provider_not_found' } }));
        }
        return;
      }

      // ─── Backends: native environments that own sessions, models, tools ───

      if (pathname === '/v1/backends' && method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({ backends: await backendManager.describe() }));
        return;
      }

      /** Resolve the backend for a request, or answer 404 and return null. */
      async function resolveBackend(backendId) {
        const id = backendId ?? (await backendManager.list())[0]?.id;
        if (!id) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'No chat backend is attached to this Gate', code: 'no_backend' } }));
          return null;
        }
        try {
          return await backendManager.get(id);
        } catch (error) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: error.message, code: 'unknown_backend' } }));
          return null;
        }
      }

      /**
       * Guard a route that needs one specific backend method.
       *
       * Answers 501 and returns false when the backend cannot serve it. The
       * point is that it always *writes*: the earlier
       * `if (!backend || typeof backend.x !== 'function') return;` shape left
       * the socket hanging with no response whenever the backend existed but
       * lacked the method, because nothing downstream answers either (the
       * `isKnownAuthenticatedRoute` 404 fires far earlier, on the path).
       */
      function requireBackendMethod(backend, name) {
        if (typeof backend?.[name] === 'function') return true;
        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: { message: `This backend does not implement ${name}`, code: 'backend_unsupported' },
        }));
        return false;
      }

      /**
       * Resolve a backend that can actually serve `method`.
       *
       * `resolveBackend` returns the *first* attached backend, which is right
       * when any of them can serve the route. It is wrong for the fronted
       * Hermes surfaces: a Gate with claude/codex/hermes/opencode attached
       * would answer /v1/skills from claude-local and 501, while hermes-local
       * sat there able to serve it. An explicit ?backendId= still wins, so a
       * caller can pin the environment; otherwise pick by capability, exactly
       * as resolveRunBackend already does for runs.
       */
      function readBotId(requestUrl, body) {
        return requestUrl.searchParams.get('bot') || body?.bot || undefined;
      }

      async function resolveConversationScope(backendId, botId) {
        // Naming a Bot names the environment: a Bot is a Hermes profile, and
        // Claude Code / Codex / OpenCode have no notion of one. Falling back
        // to the *first* attached environment — which sorts before Hermes on a
        // typical Gate — answered every Bot conversation with 501 while the
        // environment that owned the Bot sat right there. Same capability-first
        // rule resolveBackendFor and resolveRunBackend already use; an explicit
        // ?backendId= still wins, so a deliberate pin is still told the truth.
        //
        // The environment id comes back with the backend because the session
        // index is keyed by it: a copy of "the sessions" only means something
        // next to the environment and the Bot it was read from.
        if (botId && !backendId) {
          for (const entry of await backendManager.list()) {
            if (!await backendCanServe(entry, 'forBot')) continue;
            const candidate = await backendManager.get(entry.id).catch(() => null);
            if (candidate && typeof candidate.forBot === 'function') {
              return { backend: await resolveForBot(candidate, botId), environmentId: entry.id };
            }
          }
        }
        const environmentId = backendId ?? (await backendManager.list())[0]?.id;
        const backend = await resolveBackend(environmentId);
        if (!backend) return null;
        if (!botId) return { backend, environmentId };
        return { backend: await resolveForBot(backend, botId), environmentId };
      }

      async function resolveConversationBackend(backendId, botId) {
        const scope = await resolveConversationScope(backendId, botId);
        return scope?.backend ?? null;
      }

      function sessionReadError(error, botId, fallbackCode) {
        const rawMessage = typeof error?.message === 'string' && error.message
          ? error.message : 'Could not read sessions';
        const missing = error?.code === 'unknown_session' || /not found/i.test(rawMessage);
        const upstreamStatus = Number(error?.status);
        const status = Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus < 600
          ? upstreamStatus : missing ? 404 : 502;
        const safeText = (text) => text
          .replace(/\b(?:Bearer|Basic)\s+[^\s,;"'}]+/gi, '[redacted]')
          .replace(/\b((?:listen[ _-]?key|api[ _-]?(?:server[ _-]?)?key|access[ _-]?token|refresh[ _-]?token|token|password|secret|authorization)["']?\s*(?:[:=]\s*)?)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[redacted]');
        const code = typeof error?.code === 'string' && error.code
          ? safeText(error.code) : missing ? 'unknown_session' : botId ? 'bot_read_failed' : fallbackCode;
        const message = safeText(rawMessage);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: { message: botId ? `Bot ${botId}: ${message}` : message, code, ...(botId ? { botId } : {}) },
        }));
      }

      /**
       * Whether the Gate keeps its own copy of this backend's sessions.
       *
       * Only a Hermes list is copied: its backend answers the query out of one
       * SQLite `state.db` that measured 3-38 s at 6.2 GB (2026-10-01), while
       * opencode answers in 0.03 s. Every other kind stays live, because a copy
       * of a cheap read is a cost with no read saved.
       */
      function indexesSessions(backend) {
        return backend?.kind === 'hermes';
      }

      /**
       * Whether a list read may be answered out of that copy.
       *
       * The copy holds one contiguous newest-first window per key, so a request
       * that carries a cursor or an offset the Gate does not understand as a page
       * bound cannot be served from it: it would silently answer the newest page
       * again. The route reads `limit`, `bot` and `backendId`; anything else
       * stays live.
       */
      function readIsIndexable(requestUrl) {
        for (const name of requestUrl.searchParams.keys()) {
          if (name !== 'limit' && name !== 'bot' && name !== 'backendId') return false;
        }
        return true;
      }

      /**
       * Answer a session list from the Gate's own copy, refilling it when the
       * copy cannot cover what was asked.
       *
       * A read the copy can cover is answered from it in microseconds and only
       * starts a refill — one the caller never waits for — when the copy has
       * gone stale. A read it cannot cover (a bigger page, or no copy at all)
       * joins a refill and waits for it up to the screen bound, because a caller
       * asking for rows the copy has never held deserves the real thing.
       *
       * The refill is NOT the screen's read: it keeps running past the bound
       * that made the screen give up, which is the whole point of the copy. A
       * cold read that needs longer than a screen will wait still lands and
       * serves every later read.
       */
      async function readIndexedSessions(backend, environmentId, botId, requestedLimit) {
        const key = sessionIndexKey(environmentId, botId);
        const cached = await sessionListIndex.get(key);
        const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : null;
        const isStale = (refreshedAt) => Date.now() - refreshedAt > sessionIndexStaleMs;
        const page = (sessions) => sessions.slice(0, limit ?? sessions.length);
        // Rows served out of a window narrower than the ask are a SHORT page, and
        // the caller has to be able to tell: the app compares the rows it got
        // with the limit it sent (sessionListMayHaveOlder) and concludes there is
        // nothing older when the page is short — so an unmarked short page hides a
        // Bot Chat that is really there, and the caller opens a second one.
        const isShort = (fetchedLimit) => limit !== null && limit > fetchedLimit;
        const refreshWindow = (window) => sessionListIndex.refresh(
          key,
          // The long bound belongs to the copy's own refill, not to the screen:
          // a cold read that needs 38 s is one this route is happy to keep
          // running after the screen has been answered.
          (asked) => backend.listSessions(asked, { timeoutMs: sessionRefreshTimeoutMs }),
          { limit: window },
        );
        // `index` is additive: `object` and `data` keep their meaning, and the
        // app's parser reads only `data` (manifest-client.ts getSessions).
        const answer = (sessions, { refreshedAt, stale = false, partial = false } = {}) => {
          res.writeHead(200);
          res.end(JSON.stringify({
            object: 'list',
            data: sessions,
            ...(partial ? { partial: true } : {}),
            index: { refreshedAt: refreshedAt ?? null, stale },
          }));
        };

        // The copy can answer this read. A stale one refills in the background;
        // a fresh one is not asked again, which is what makes a warm list free.
        if (cached && cached.fetchedLimit > 0 && (limit === null || limit <= cached.fetchedLimit)) {
          const stale = isStale(cached.refreshedAt);
          if (stale) void refreshWindow(cached.fetchedLimit).catch(() => undefined);
          answer(page(cached.sessions), { refreshedAt: cached.refreshedAt, stale });
          return;
        }

        // It cannot: wait for a real read, bounded by what a screen will wait.
        // The window asked for is the caller's, capped at what the copy keeps.
        const outcome = await boundedOutcome(
          refreshWindow(Math.min(limit ?? sessionListIndex.maxRows, sessionListIndex.maxRows)),
          sessionReadBoundMs,
        );
        if (outcome.settled) {
          if (outcome.error) {
            sessionReadError(outcome.error, botId, 'session_list_failed');
            return;
          }
          answer(page(outcome.value.sessions), {
            refreshedAt: outcome.value.refreshedAt,
            partial: isShort(outcome.value.fetchedLimit),
          });
          return;
        }
        // Out of time with the read still running. Whatever the copy holds is
        // true and worth showing; an empty copy has nothing to say but the wait.
        const held = await sessionListIndex.get(key);
        if (held?.sessions.length) {
          answer(page(held.sessions), {
            refreshedAt: held.refreshedAt,
            stale: true,
            partial: isShort(held.fetchedLimit),
          });
          return;
        }
        sessionReadError(
          Object.assign(new Error(SESSION_LIST_SLOW_MESSAGE), { code: 'backend_timeout' }),
          botId,
          'session_list_failed',
        );
      }

      /**
       * Wait for `promise` up to `boundMs`, as a value rather than a race.
       *
       * Never rejects: a caller that walked away at the bound still needs the
       * read's own failure to reach it, and a read nobody awaits any more must
       * not surface as an unhandled rejection in the Gate's own process.
       */
      function boundedOutcome(promise, boundMs) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ settled: false }), boundMs);
          timer.unref?.();
          promise.then(
            (value) => { clearTimeout(timer); resolve({ settled: true, value }); },
            (error) => { clearTimeout(timer); resolve({ settled: true, error }); },
          );
        });
      }

      /**
       * A backend that refuses a delete is answering about the request, not
       * crashing the Gate. Unwrapped, every refusal became a generic 500 with
       * a logged stack, and the app could not tell "that job is already gone"
       * from "the Gate is broken" — so it retried, or showed nothing.
       */
      function deleteRefusal(error, fallbackCode) {
        const message = typeof error?.message === 'string' && error.message
          ? error.message : 'The backend refused the delete';
        const missing = error?.code === 'unknown_session' || /not found/i.test(message);
        const upstreamStatus = Number(error?.status);
        const status = Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus < 600
          ? upstreamStatus : missing ? 404 : 502;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message,
            code: typeof error?.code === 'string' && error.code ? error.code : fallbackCode,
          },
        }));
      }

      async function resolveForBot(backend, botId) {
        if (typeof backend.forBot !== 'function') {
          res.writeHead(501, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: { message: 'This backend does not implement bots', code: 'backend_unsupported' },
          }));
          return null;
        }
        try {
          return await backend.forBot(botId);
        } catch (error) {
          const code = error.code ?? 'backend_unsupported';
          const status = code === 'unknown_bot' ? 404 : code === 'bot_not_routable' ? 409 : 501;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: error.message, code } }));
          return null;
        }
      }

      async function resolveBackendFor(method) {
        const explicit = url.searchParams.get('backendId');
        if (explicit) {
          const backend = await resolveBackend(explicit);
          if (!backend) return null;
          return requireBackendMethod(backend, method) ? backend : null;
        }
        // A backend that fails to start is recorded, not forgotten: if nothing
        // reachable implements the method, an outage must not be reported as
        // "unsupported" (backend-resolution.mjs).
        const failures = [];
        for (const entry of await backendManager.list()) {
          // A backend that is known not to implement the method is not evidence
          // of an outage, so it never has to answer — or start — at all.
          if (!await backendCanServe(entry, method)) continue;
          const backend = await backendManager.get(entry.id).catch((error) => {
            failures.push({ id: entry.id, error });
            return null;
          });
          if (backend && typeof backend[method] === 'function') return backend;
        }
        const unresolved = unresolvedBackendResponse(method, failures);
        res.writeHead(unresolved.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(unresolved.body));
        return null;
      }

      /**
       * Agentic runs, delegated to whichever backend implements them.
       *
       * The Gate's CLI backends run a turn synchronously and have no notion of
       * a run id, so runs were simply absent and the app correctly reported
       * "Runs not offered". Hermes has the full lifecycle, so fronting it gives
       * the Gate a runs API without reimplementing an agent loop. Paths mirror
       * Hermes exactly, which is also what the app's client already speaks.
       */
      async function resolveRunBackend(backendId, botId = readBotId(url)) {
        const explicit = backendId ?? url.searchParams.get('backendId');
        if (botId) {
          let selected = explicit;
          if (!selected) {
            for (const entry of await backendManager.list()) {
              if (!await backendCanServe(entry, 'forBot')) continue;
              const candidate = await backendManager.get(entry.id).catch(() => null);
              if (typeof candidate?.forBot === 'function') {
                selected = entry.id;
                break;
              }
            }
          }
          const backend = await resolveConversationBackend(selected, botId);
          if (!backend || !requireBackendMethod(backend, 'startRun')) return null;
          return { backend, backendId: selected, botId };
        }
        if (explicit) {
          const backend = await resolveBackend(explicit);
          if (!backend) return null;
          if (typeof backend.startRun !== 'function') {
            res.writeHead(501, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: { message: `Backend "${explicit}" does not implement runs`, code: 'runs_unsupported' },
            }));
            return null;
          }
          return { backend, backendId: explicit };
        }
        // No backend named: pick the first that can actually run one.
        for (const entry of await backendManager.list()) {
          if (!await backendCanServe(entry, 'startRun')) continue;
          const backend = await backendManager.get(entry.id).catch(() => null);
          if (backend && typeof backend.startRun === 'function') return { backend, backendId: entry.id };
        }
        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: { message: 'No attached backend implements runs', code: 'runs_unsupported' },
        }));
        return null;
      }

      function runRequestError(error, fallbackCode, fallbackMessage = 'Run request failed') {
        const upstreamStatus = Number(error?.status);
        const status = Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus < 600
          ? upstreamStatus : 502;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: {
          message: typeof error?.message === 'string' && error.message ? error.message : fallbackMessage,
          code: typeof error?.code === 'string' && error.code ? error.code : fallbackCode,
        } }));
      }

      async function frontedRequest(request, fallbackCode) {
        try {
          const body = JSON.stringify(await request());
          res.writeHead(200);
          res.end(body);
        } catch (error) {
          runRequestError(error, fallbackCode, 'Gateway request failed');
        }
      }

      function readRunHandle(encoded) {
        try {
          const handle = decodeURIComponent(encoded);
          return { handle, ...(decodeBackendRunHandle(handle) ?? { runId: handle }) };
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid Gate run handle', code: 'invalid_request' } }));
          return null;
        }
      }

      async function validateRunScope(run) {
        const botId = readBotId(url);
        if (run.botId && botId && run.botId !== botId) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: {
            message: 'This run belongs to a different Bot', code: 'run_bot_mismatch',
          } }));
          return false;
        }
        const explicit = url.searchParams.get('backendId');
        if (run.backendId && explicit && explicit !== run.backendId) {
          if (!await resolveRunBackend(explicit)) return false;
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: {
            message: 'This run belongs to a different CLI environment', code: 'run_backend_mismatch',
          } }));
          return false;
        }
        return true;
      }

      async function resolveExistingRun(run) {
        if (!await validateRunScope(run)) return null;
        const explicit = url.searchParams.get('backendId');
        const resolved = await resolveRunBackend(explicit || run.backendId, run.botId || readBotId(url));
        return resolved?.backend ?? null;
      }

      if (pathname === '/v1/runs' && method === 'POST') {
        const body = (await readJsonBody(req, { maxBytes: AUTH_MAX_BODY_BYTES })) ?? {};
        const resolved = await resolveRunBackend(body.backendId, readBotId(url, body));
        if (!resolved) return;
        const { backend, backendId, botId } = resolved;
        const prompt = typeof body.input === 'string'
          ? body.input
          : lastUserText(Array.isArray(body.input) ? body.input : body.messages);
        if (!prompt) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: "Missing 'input'", code: 'invalid_request' } }));
          return;
        }
        let started;
        try {
          started = await backend.startRun(prompt, {
            sessionId: body.session_id ?? body.sessionId,
            model: body.model,
          });
        } catch (error) {
          runRequestError(error, 'run_start_failed');
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(scopeBackendRunResponse(started, backendId, botId)));
        return;
      }

      const runEventsMatch = pathname.match(/^\/v1\/runs\/([^/]+)\/events$/);
      if (runEventsMatch && method === 'GET') {
        const run = readRunHandle(runEventsMatch[1]);
        if (!run || !await validateRunScope(run)) return;
        // Handles preserve scope even when the CLI environment is offline.
        // Legacy requests with an explicit Bot must not share an unscoped archive.
        const botId = run.botId || readBotId(url);
        let backend;
        let handle = run.handle;
        if (botId && !run.botId) {
          const resolved = await resolveRunBackend(run.backendId, botId);
          if (!resolved) return;
          backend = resolved.backend;
          handle = scopeBackendRunResponse({ id: run.runId }, resolved.backendId, botId).id;
        }
        const runId = backendRunArchiveKey(handle);
        // Replay answers from the Gate's own archive when one exists: Hermes
        // buffers a run's events only while it is live, so replaying a
        // finished run upstream 404s. The archived bytes are exactly what was
        // relayed, and they stay readable after a Gate restart or while
        // Hermes is down. An actively-teed run is still live, so it proxies
        // through (the archive would only be a growing snapshot). And a file
        // WITHOUT its completeness marker is a partial from a relay that
        // never reached the stream's end — serving it as the verdict would
        // silently truncate the run, so an unmarked file re-streams live
        // (and heals) instead.
        const archived = runStreams.isActive(runId) ? null : await runStreams.read(runId);
        if (archived !== null && runStreams.isComplete(runId)) {
          // Whole history, in one write: there is nothing to wait for, so this
          // response advertises no heartbeat (see sseHeaders).
          res.writeHead(200, sseHeaders({}, { keepalive: false }));
          res.write(archived);
          res.end();
          return;
        }
        backend ??= await resolveExistingRun(run);
        if (!backend) return;
        if (!requireBackendMethod(backend, 'runEvents')) return;
        let upstream;
        try {
          upstream = await backend.runEvents(run.runId);
        } catch (error) {
          if (archived !== null) {
            // Best evidence fallback: a partial archive exists but the
            // upstream refuses to re-stream (the run finished and its live
            // buffer is gone, or Hermes is down). Serve what was captured —
            // but FLAGGED, so a truncated history can never read as a
            // complete verdict.
            res.writeHead(200, sseHeaders({ 'X-Run-Archive-Incomplete': 'true' }, { keepalive: false }));
            res.write(archived);
            res.end();
            return;
          }
          // FAIL-HONEST: an upstream refusal is a real status, never a 500.
          // Hermes answering 404 means the run is finished or unknown and its
          // live buffer is gone — the caller should hear exactly that.
          const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
            ? error.status
            : 502;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              message: error.message,
              code: error.code ?? (status === 404 ? 'run_events_unavailable' : 'upstream_error'),
            },
          }));
          return;
        }
        res.writeHead(200, sseHeaders());
        // Relay bytes unchanged: the app already parses Hermes run events.
        // The single tee-holder also archives them (backend-run-streams.mjs)
        // so a completed run replays from disk after the live buffer is gone.
        const tee = runStreams.begin(runId);
        const reader = upstream.body?.getReader?.();
        if (!reader) {
          res.end();
          if (tee) runStreams.end(runId);
          return;
        }
        // A run with nothing to say can be quiet for minutes, and a quiet
        // stream behind a NAT is a dead stream the phone cannot tell apart.
        // The heartbeat has to wait for a frame boundary: the bytes below are
        // relayed exactly as they arrive, and a comment written into the middle
        // of a half-written line would terminate it and hand the client a
        // truncated frame.
        const frames = createSseFrameTracker();
        const stopKeepalive = startSseKeepalive(res, {
          intervalMs: keepaliveIntervalMs,
          canWrite: () => frames.atBoundary,
        });
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            res.write(chunk);
            frames.push(chunk);
            if (tee) runStreams.append(runId, chunk);
          }
          // Clean end of the upstream stream: the archive now holds the whole
          // story and may be served as a verdict later. A torn relay (catch
          // below) leaves the file unmarked, so a truncated snapshot can
          // never read as complete.
          if (tee) runStreams.markComplete(runId);
          res.end();
        } catch {
          // A torn relay closes the response; the partial archive stays
          // readable but UNMARKED (the client drops one malformed trailing
          // frame, and a later replay re-streams live instead of trusting it).
          try { res.end(); } catch { /* socket already gone */ }
        } finally {
          stopKeepalive();
          if (tee) runStreams.end(runId);
        }
        return;
      }

      const runStopMatch = pathname.match(/^\/v1\/runs\/([^/]+)\/stop$/);
      if (runStopMatch && method === 'POST') {
        const run = readRunHandle(runStopMatch[1]);
        if (!run) return;
        const backend = await resolveExistingRun(run);
        if (!backend) return;
        try {
          await backend.stopRun(run.runId);
        } catch (error) {
          runRequestError(error, 'run_stop_failed');
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ stopped: true }));
        return;
      }

      const runApprovalMatch = pathname.match(/^\/v1\/runs\/([^/]+)\/approval$/);
      if (runApprovalMatch && method === 'POST') {
        const body = (await readJsonBody(req, { maxBytes: AUTH_MAX_BODY_BYTES })) ?? {};
        const run = readRunHandle(runApprovalMatch[1]);
        if (!run) return;
        const backend = await resolveExistingRun(run);
        if (!backend) return;
        if (!requireBackendMethod(backend, 'replyApproval')) return;
        try {
          await backend.replyApproval(run.runId, {
            approved: body.approved,
            feedback: body.feedback,
          });
        } catch (error) {
          runRequestError(error, 'run_approval_failed');
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      const runStatusMatch = pathname.match(/^\/v1\/runs\/([^/]+)$/);
      if (runStatusMatch && method === 'GET') {
        const run = readRunHandle(runStatusMatch[1]);
        if (!run) return;
        const backend = await resolveExistingRun(run);
        if (!backend) return;
        let status;
        try {
          status = await backend.getRunStatus(run.runId);
        } catch (error) {
          runRequestError(error, 'run_status_failed');
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(run.backendId ? scopeBackendRunResponse(status, run.backendId, run.botId || readBotId(url)) : status));
        return;
      }

      // Tools, from whichever backend owns them. The Gate has claimed
      // `tools: true` since the adapter declared the capability; this is the
      // route that makes the claim true.
      if (pathname === '/v1/toolsets' && method === 'GET') {
        const backend = await resolveBackendFor('listToolsets');
        if (!backend) return;
        await frontedRequest(() => backend.listToolsets(), 'toolsets_read_failed');
        return;
      }

      // Shell. The stream is the session: SSE out, POST in. There is no
      // /resize — the client never called it, and a route that accepts
      // dimensions nothing can apply is the dead-config shape this codebase
      // keeps finding. Restore it alongside a real PTY, not before.
      if (pathname === '/v1/terminal/stream' && method === 'GET') {
        res.writeHead(200, sseHeaders());
        // A shell at an idle prompt says nothing for as long as the user reads
        // it, and the socket is exactly the thing a locked phone loses.
        startSseKeepalive(res, { intervalMs: keepaliveIntervalMs });
        const send = (event, data) => {
          if (event) res.write(`event: ${event}\n`);
          res.write(`data: ${data}\n\n`);
        };
        let session;
        try {
          session = terminalSessions.open({
            owner: callerId,
            onChunk: (text) => send(null, Buffer.from(text, 'utf8').toString('base64')),
            onExit: (code) => { send('exit', JSON.stringify({ code })); res.end(); },
            onError: (message) => { send('error', JSON.stringify({ error: message })); res.end(); },
          });
        } catch (error) {
          // The client reads an `error` field on the session event as a failed
          // open, so a refusal arrives as a message rather than a dead stream.
          send('session', JSON.stringify({ error: error.message }));
          res.end();
          return;
        }
        send('session', JSON.stringify({ sid: session.sid }));
        terminalStreams.add(res);
        // The stream owns the session's lifetime: a phone that drops off wifi
        // must not leave a shell running on the host forever.
        res.on('close', () => {
          terminalStreams.delete(res);
          session.close();
        });
        return;
      }

      if (pathname === '/v1/terminal/input' && method === 'POST') {
        const body = (await readJsonBody(req, { maxBytes: AUTH_MAX_BODY_BYTES })) ?? {};
        const session = terminalSessions.get(body.sid);
        if (session && session.owner !== null && session.owner !== callerId) {
          // Answer as if it does not exist: confirming the id to a caller that
          // does not own it leaks which sessions are live.
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: { message: `unknown terminal session "${body.sid ?? ''}"`, code: 'unknown_session' },
          }));
          return;
        }
        if (!session) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: { message: `unknown terminal session "${body.sid ?? ''}"`, code: 'unknown_session' },
          }));
          return;
        }
        session.write(body.data ?? '');
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // Skills, diagnostics and cron, fronted from the backend. Each was
      // reachable on Hermes all along; the Gate could not offer them because
      // it served no route, so the app's tiles read "Not offered".
      if (pathname === '/v1/skills' && method === 'GET') {
        const backend = await resolveBackendFor('listSkills');
        if (!backend) return;
        await frontedRequest(() => backend.listSkills(), 'skills_read_failed');
        return;
      }

      if (pathname === '/health/detailed' && method === 'GET') {
        const backend = await resolveBackendFor('healthDetailed');
        if (!backend) return;
        await frontedRequest(() => backend.healthDetailed(), 'diagnostics_read_failed');
        return;
      }

      if (pathname === '/v1/bots/handoff' && method === 'POST') {
        const body = (await readJsonBody(req, { maxBytes: AUTH_MAX_BODY_BYTES })) ?? {};
        const backend = await resolveBackendFor('handoffMention');
        if (!backend) return;
        try {
          const result = await backend.handoffMention({
            fromId: body.fromId,
            toId: body.toId,
            text: body.text,
          });
          res.writeHead(200);
          res.end(JSON.stringify(result ?? { ok: true }));
        } catch (error) {
          const status = error.status || 502;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: error.message, code: error.code ?? 'handoff_failed' } }));
        }
        return;
      }

      if (pathname === '/v1/jobs' && method === 'GET') {
        const botId = readBotId(url);
        const backend = botId
          ? await resolveConversationBackend(url.searchParams.get('backendId'), botId)
          : await resolveBackendFor('listJobs');
        if (!backend) return;
        if (!requireBackendMethod(backend, 'listJobs')) return;
        await frontedRequest(() => backend.listJobs(), 'jobs_read_failed');
        return;
      }

      if (pathname === '/v1/jobs' && method === 'POST') {
        const body = (await readJsonBody(req, { maxBytes: AUTH_MAX_BODY_BYTES })) ?? {};
        const botId = readBotId(url, body);
        const backend = botId
          ? await resolveConversationBackend(body.backendId ?? url.searchParams.get('backendId'), botId)
          : await resolveBackendFor('createJob');
        if (!backend) return;
        if (!requireBackendMethod(backend, 'createJob')) return;
        await frontedRequest(() => backend.createJob(body), 'job_create_failed');
        return;
      }

      if (pathname === '/v1/bots' && method === 'GET') {
        const backend = await resolveBackendFor('listBots');
        if (!backend) return;
        try {
          const roster = await backend.listBots();
          res.writeHead(200);
          res.end(JSON.stringify(roster));
        } catch (error) {
          const upstreamStatus = Number(error?.status);
          const status = Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus < 600
            ? upstreamStatus : 502;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: {
            message: typeof error?.message === 'string' && error.message ? error.message : 'Could not read the Bot roster',
            code: typeof error?.code === 'string' && error.code ? error.code : 'bot_read_failed',
          } }));
        }
        return;
      }

      if (pathname === '/v1/bots' && method === 'POST') {
        const body = (await readJsonBody(req, { maxBytes: AUTH_MAX_BODY_BYTES })) ?? {};
        const backend = await resolveBackendFor('createBot');
        if (!backend) return;
        try {
          const created = await backend.createBot({
            name: body.name,
            soul: body.soul,
            inheritKeys: Boolean(body.inheritKeys),
            description: body.description,
            modelId: body.modelId,
            providerId: body.providerId,
          });
          res.writeHead(200);
          res.end(JSON.stringify(created));
        } catch (error) {
          const code = error.code ?? 'bot_create_failed';
          const status = error.status || (code === 'invalid_bot_name' ? 400 : code === 'bot_exists' ? 409 : 502);
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: error.message, code } }));
        }
        return;
      }

      const botMemoryMatch = pathname.match(/^\/v1\/bots\/([^/]+)\/memory$/);
      if (botMemoryMatch && method === 'GET') {
        // P2: a Bot's memory read, on demand like its soul. The backend owns
        // which files are memory; the Gate adds no path from the client.
        const backend = await resolveBackendFor('getBotMemory');
        if (!backend) return;
        try {
          const memory = await backend.getBotMemory({ id: decodeURIComponent(botMemoryMatch[1]) });
          res.writeHead(200);
          res.end(JSON.stringify(memory));
        } catch (error) {
          const code = error.code ?? 'bot_memory_read_failed';
          const status = error.status || (code === 'unknown_bot' ? 404 : 502);
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: error.message, code } }));
        }
        return;
      }

      const botMemoryWriteMatch = pathname.match(/^\/v1\/bots\/([^/]+)\/memory\/([^/]+)$/);
      if (botMemoryWriteMatch && method === 'PUT') {
        // P2: a confirmed memory edit. The backend enforces the whitelist and
        // an unknown Bot is refused by name.
        const backend = await resolveBackendFor('setBotMemory');
        if (!backend) return;
        const body = (await readJsonBody(req, { maxBytes: AUTH_MAX_BODY_BYTES })) ?? {};
        try {
          const result = await backend.setBotMemory({
            id: decodeURIComponent(botMemoryWriteMatch[1]),
            name: decodeURIComponent(botMemoryWriteMatch[2]),
            text: typeof body.text === 'string' ? body.text : '',
          });
          res.writeHead(200);
          res.end(JSON.stringify(result));
        } catch (error) {
          const code = error.code ?? 'bot_memory_write_failed';
          const status = error.status || (code === 'unknown_bot' ? 404 : 502);
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: error.message, code } }));
        }
        return;
      }

      const botEditMatch = pathname.match(/^\/v1\/bots\/([^/]+)$/);
      if (botEditMatch && method === 'GET') {
        // One Bot, fetched only when a Bot is opened. Kept off /v1/bots so the
        // roster read stays small — a soul can be long and the list is re-read
        // constantly. The backend decides what is public; the listen key never
        // reaches this response.
        const backend = await resolveBackendFor('getBot');
        if (!backend) return;
        try {
          const bot = await backend.getBot({ id: decodeURIComponent(botEditMatch[1]) });
          res.writeHead(200);
          res.end(JSON.stringify(bot));
        } catch (error) {
          const code = error.code ?? 'bot_read_failed';
          const status = error.status || (code === 'unknown_bot' ? 404 : 502);
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: error.message, code } }));
        }
        return;
      }

      if (botEditMatch && method === 'PATCH') {
        const body = (await readJsonBody(req, { maxBytes: AUTH_MAX_BODY_BYTES })) ?? {};
        const backend = await resolveBackendFor('updateBot');
        if (!backend) return;
        try {
          const updated = await backend.updateBot({
            id: decodeURIComponent(botEditMatch[1]),
            soul: body.soul,
            description: body.description,
            modelId: body.modelId,
            providerId: body.providerId,
          });
          res.writeHead(200);
          res.end(JSON.stringify(updated));
        } catch (error) {
          const code = error.code ?? 'bot_update_failed';
          const status = error.status
            || (code === 'invalid_bot_name' ? 400 : code === 'unknown_bot' ? 404 : 502);
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: error.message, code } }));
        }
        return;
      }

      if (pathname === '/v1/bot-groups' && method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({ object: 'list', data: await botGroups.list() }));
        return;
      }

      if (pathname === '/v1/bot-groups' && method === 'POST') {
        const body = (await readJsonBody(req, { maxBytes: AUTH_MAX_BODY_BYTES })) ?? {};
        try {
          const group = await botGroups.create({ name: body.name, memberIds: body.memberIds });
          res.writeHead(200);
          res.end(JSON.stringify(group));
        } catch (error) {
          res.writeHead(error.status || 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: error.message, code: error.code ?? 'invalid_group' } }));
        }
        return;
      }

      const groupEditMatch = pathname.match(/^\/v1\/bot-groups\/([^/]+)$/);
      if (groupEditMatch && method === 'PATCH') {
        const body = (await readJsonBody(req, { maxBytes: AUTH_MAX_BODY_BYTES })) ?? {};
        // PATCH carries whichever room fields the caller is changing: name
        // (rename) and/or memberIds (append members). A request naming
        // neither is refused rather than answered with an unchanged room.
        if (!Array.isArray(body.memberIds) && typeof body.name !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'nothing to update', code: 'invalid_group' } }));
          return;
        }
        // Validate BOTH halves of a patch before either mutates: a request
        // that adds members AND renames must never land half-applied because
        // the name turned out blank — the rename would have refused anyway,
        // just after the members were already written.
        if (typeof body.name === 'string' && !body.name.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'name required', code: 'invalid_group' } }));
          return;
        }
        try {
          let group = null;
          if (Array.isArray(body.memberIds)) {
            group = await botGroups.addMembers(decodeURIComponent(groupEditMatch[1]), body.memberIds);
          }
          if (typeof body.name === 'string') {
            group = await botGroups.rename(decodeURIComponent(groupEditMatch[1]), body.name);
          }
          res.writeHead(200);
          res.end(JSON.stringify(group));
        } catch (error) {
          res.writeHead(error.status || 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: error.message, code: error.code ?? 'invalid_group' } }));
        }
        return;
      }

      if (groupEditMatch && method === 'DELETE') {
        try {
          const result = await botGroups.delete(decodeURIComponent(groupEditMatch[1]));
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (error) {
          res.writeHead(error.status || 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: error.message, code: error.code ?? 'group_delete_failed' } }));
        }
        return;
      }

      const groupLeaveMatch = pathname.match(/^\/v1\/bot-groups\/([^/]+)\/leave$/);
      if (groupLeaveMatch && method === 'POST') {
        const body = (await readJsonBody(req, { maxBytes: AUTH_MAX_BODY_BYTES })) ?? {};
        try {
          const group = await botGroups.leave(decodeURIComponent(groupLeaveMatch[1]), body.memberId);
          res.writeHead(200);
          res.end(JSON.stringify(group));
        } catch (error) {
          res.writeHead(error.status || 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: error.message, code: error.code ?? 'group_leave_failed' } }));
        }
        return;
      }

      const groupMessageMatch = pathname.match(/^\/v1\/bot-groups\/([^/]+)\/messages$/);
      if (groupMessageMatch && method === 'GET') {
        try {
          const entries = await botGroups.history(decodeURIComponent(groupMessageMatch[1]));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data: entries }));
        } catch (error) {
          res.writeHead(error.status || 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: error.message, code: error.code ?? 'group_history_failed' } }));
        }
        return;
      }
      if (groupMessageMatch && method === 'POST') {
        const body = (await readJsonBody(req, { maxBytes: AUTH_MAX_BODY_BYTES })) ?? {};
        const group = await botGroups.get(decodeURIComponent(groupMessageMatch[1]));
        if (!group) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'group not found', code: 'unknown_group' } }));
          return;
        }
        const backend = await resolveBackendFor('deliverGroupMessage');
        if (!backend) return;
        try {
          // The create-time door check is create-time truth; a room can sit
          // unvisited while the host's roster changes (a profile renamed or
          // removed, a backend reordered). Re-check the LIVE roster at the
          // send door so the first message refuses with the membership
          // verdict — naming the dead member — before any bot has spoken a
          // partial round.
          await botGroups.verifyMembers(group.memberIds);
          const result = await backend.deliverGroupMessage({
            name: group.name,
            memberIds: group.memberIds,
            mentionedIds: body.mentionedIds,
            text: body.text,
          });
          // The transcript is Gate-owned so the conversation survives the
          // visit; a persistence failure must not fail a send that already
          // succeeded — the replies are the response contract.
          try {
            await botGroups.appendMessages(
              group.id,
              transcriptEntriesForSend({ text: body.text, replies: result.replies }),
            );
          } catch (historyError) {
            // A room disbanded while the round ran (between the send door and
            // the append) is not a persistence glitch: the room is GONE and
            // nothing will ever replay. Answering a pristine success would let
            // the phone keep showing a live-looking conversation the Gate
            // deleted — the lost transcript is a fact the response must carry.
            if (historyError?.code === 'unknown_group') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ...result, roomDisbanded: true }));
              return;
            }
            console.warn(`bot-groups: transcript append failed for ${group.id}:`, historyError?.message ?? historyError);
          }
          res.writeHead(200);
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(error.status || 502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: error.message, code: error.code ?? 'group_send_failed' } }));
        }
        return;
      }

      const jobActionMatch = pathname.match(/^\/v1\/jobs\/([^/]+)\/(run|pause|resume)$/);
      if (jobActionMatch && method === 'POST') {
        const [, rawJobId, action] = jobActionMatch;
        const jobId = decodeURIComponent(rawJobId);
        const body = (await readJsonBody(req, { maxBytes: AUTH_MAX_BODY_BYTES })) ?? {};
        const botId = readBotId(url, body);
        const methodName = action === 'run' ? 'runJob' : 'setJobPaused';
        const backend = botId
          ? await resolveConversationBackend(body.backendId ?? url.searchParams.get('backendId'), botId)
          : await resolveBackendFor(methodName);
        if (!backend) return;
        if (!requireBackendMethod(backend, methodName)) return;
        await frontedRequest(async () => {
          const result = action === 'run'
            ? await backend.runJob(jobId)
            : await backend.setJobPaused(jobId, action === 'pause');
          return result ?? { ok: true };
        }, `job_${action}_failed`);
        return;
      }

      // Destructive counterpart to the run/pause/resume job routes above.
      // Mirrors their backend-resolution shape (bot-scoped via readBotId,
      // gateway-scoped via resolveBackendFor) and the same `requireBackendMethod`
      // guard so an unsupported backend answers 400 honestly instead of 404.
      const jobDeleteMatch = pathname.match(/^\/v1\/jobs\/([^/]+)$/);
      if (jobDeleteMatch && method === 'DELETE') {
        const [, rawJobId] = jobDeleteMatch;
        const jobId = decodeURIComponent(rawJobId);
        const body = (await readJsonBody(req, { maxBytes: AUTH_MAX_BODY_BYTES })) ?? {};
        const botId = readBotId(url, body);
        const backend = botId
          ? await resolveConversationBackend(body.backendId ?? url.searchParams.get('backendId'), botId)
          : await resolveBackendFor('removeJob');
        if (!backend) return;
        if (!requireBackendMethod(backend, 'removeJob')) return;
        try {
          await backend.removeJob(jobId);
        } catch (error) {
          deleteRefusal(error, 'job_delete_failed');
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (pathname === '/v1/sessions' && method === 'GET') {
        const botId = readBotId(url);
        const scope = await resolveConversationScope(url.searchParams.get('backendId'), botId);
        // `scope?.backend`, not `scope`: a Bot that cannot be resolved leaves a
        // scope whose backend is null AND has already written the refusal. Using
        // the scope alone fell through to `backend.listSessions`, threw, and the
        // catch answered a second time over a response that was already sent.
        if (!scope?.backend) return;
        const { backend, environmentId } = scope;
        const limit = Number(url.searchParams.get('limit')) || undefined;
        // The limit must travel: slicing here cannot recover rows the backend
        // never returned. Hermes answers /api/sessions with its own default
        // page, so a request for 200 quietly meant 50 — and a Bot Chat older
        // than that window read as absent, which sent the caller off to create
        // a second one that Hermes then refused by title.
        //
        // A Hermes list is answered from the Gate's own copy of it (SPD-1/2):
        // that query costs 3-38 s against a 6.2 GB state.db, and this is the
        // read every screen that lists threads waits on.
        if (indexesSessions(backend) && readIsIndexable(url)) {
          await readIndexedSessions(backend, environmentId, botId, limit);
          return;
        }
        let sessions;
        try {
          sessions = await backend.listSessions(limit);
        } catch (error) {
          sessionReadError(error, botId, 'session_list_failed');
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ object: 'list', data: limit ? sessions.slice(0, limit) : sessions }));
        return;
      }

      if (pathname === '/v1/sessions' && method === 'POST') {
        const body = (await readJsonBody(req, { maxBytes: AUTH_MAX_BODY_BYTES })) ?? {};
        const botId = readBotId(url, body);
        const scope = await resolveConversationScope(body.backendId, botId);
        if (!scope?.backend) return;
        const { backend, environmentId } = scope;
        let created;
        try {
          created = await backend.createSession({ title: body.title, model: body.model });
        } catch (error) {
          // A backend refusing the request ("Title already in use") is its
          // answer, not a Gate crash: pass its status and words through so the
          // caller can act on them instead of seeing Internal Server Error.
          const status = Number(error?.status) >= 400 && Number(error?.status) < 600 ? Number(error.status) : 502;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: { message: error?.message ?? 'Could not create a session', code: error?.code ?? 'session_create_failed' },
          }));
          return;
        }
        // Written through to the Gate's own copy, so the new session is the
        // newest row of the very next list instead of one more slow read away.
        if (indexesSessions(backend)) {
          await sessionListIndex.upsert(sessionIndexKey(environmentId, botId), created);
        }
        res.writeHead(200);
        res.end(JSON.stringify(created));
        return;
      }

      const sessionMessagesMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/messages$/);
      if (sessionMessagesMatch && method === 'GET') {
        const backend = await resolveConversationBackend(url.searchParams.get('backendId'), readBotId(url));
        if (!backend) return;
        const limit = Number(url.searchParams.get('limit')) || undefined;
        const before = url.searchParams.get('before') || undefined;

        // Paging is done here rather than in the backends: all three read their
        // whole transcript upstream (a file, thread/read, /session/{id}/message)
        // and cannot ask for a slice, so pushing a cursor down would just be a
        // slice wearing a different hat. Doing it here still wins the part that
        // matters to the client -- a bounded, stable page instead of
        // re-downloading the entire window with an ever-larger limit.
        // A backend refusing a session id is an answer about the request, not
        // a crash in the Gate. Unwrapped, it fell to the outer catch as a 500
        // and printed "Request handler error" over the operator's log — while
        // the app, seeing only a server error, could not tell "this session is
        // gone, start a new one" from "the Gate is broken".
        let all;
        try {
          all = await backend.listMessages(decodeURIComponent(sessionMessagesMatch[1]));
        } catch (error) {
          sessionReadError(error, readBotId(url), 'session_read_failed');
          return;
        }
        const cutoff = before ? all.findIndex((message) => message?.id === before) : -1;
        // An unknown cursor must not silently behave like "no cursor" and
        // re-serve the newest page; that would loop the client forever.
        if (before && cutoff === -1) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `unknown cursor: ${before}` }));
          return;
        }

        const upper = cutoff === -1 ? all.length : cutoff;
        const lower = typeof limit === 'number' ? Math.max(0, upper - limit) : 0;
        const page = all.slice(lower, upper);

        res.writeHead(200);
        res.end(
          JSON.stringify({
            object: 'list',
            data: page,
            hasMore: lower > 0,
            nextBefore: lower > 0 ? (page[0]?.id ?? null) : null,
          }),
        );
        return;
      }

      const sessionMatch = pathname.match(/^\/v1\/sessions\/([^/]+)$/);
      if (sessionMatch && method === 'DELETE') {
        const botId = readBotId(url);
        const scope = await resolveConversationScope(url.searchParams.get('backendId'), botId);
        if (!scope?.backend) return;
        const { backend, environmentId } = scope;
        const sessionId = decodeURIComponent(sessionMatch[1]);
        try {
          await backend.deleteSession(sessionId);
        } catch (error) {
          deleteRefusal(error, 'session_delete_failed');
          return;
        }
        // Gone upstream, so gone from the copy too — otherwise the next list
        // would answer from the Gate's own rows and show a deleted session.
        if (indexesSessions(backend)) {
          await sessionListIndex.remove(sessionIndexKey(environmentId, botId), sessionId);
        }
        res.writeHead(200);
        res.end(JSON.stringify({ deleted: true }));
        return;
      }

      if (pathname === '/v1/environments' && method === 'GET') {
        const records = await environmentStore.list();
        const environments = [];
        for (const record of records) {
          const status = environmentService.environmentState.get(record.id);
          environments.push(sanitizeEnvironment(record, status));
        }
        res.writeHead(200);
        res.end(JSON.stringify({ environments }));
        return;
      }

      const runStart = pathname.match(/^\/v1\/environments\/([^/]+)\/runs$/);
      if (runStart && method === 'POST') {
        const body = (await readJsonBody(req, { maxBytes: AUTH_MAX_BODY_BYTES })) ?? {};
        try {
          const handle = await environmentService.startRun({
            environmentId: decodeURIComponent(runStart[1]),
            ...body,
          });
          res.writeHead(200);
          res.end(JSON.stringify({ runId: handle.runId }));
        } catch (error) {
          // Both workspace rejections are operator-fixable request problems
          // (a path outside the roots, or a root that is not on disk), not
          // Gate-state conflicts — say so with 400, message verbatim.
          res.writeHead(
            error.code === 'workspace_policy_violation' || error.code === 'workspace_missing' ? 400 : 409,
          );
          res.end(JSON.stringify({ error: { message: error.message, code: error.code || 'run_failed' } }));
        }
        return;
      }

      if (runStart && method === 'GET') {
        try {
          // require() first so a typo'd environment id is a 404, not an
          // empty list pretending the environment has never run anything.
          await environmentService.require(decodeURIComponent(runStart[1]));
          const runs = environmentService.listRuns(decodeURIComponent(runStart[1]));
          res.writeHead(200);
          res.end(JSON.stringify({ runs }));
        } catch (error) {
          res.writeHead(error.code === 'environment_not_found' ? 404 : 500);
          res.end(JSON.stringify({ error: { message: error.message, code: error.code || 'runs_list_failed' } }));
        }
        return;
      }

      const runEvents = pathname.match(/^\/v1\/environments\/([^/]+)\/runs\/([^/]+)\/events$/);
      if (runEvents && method === 'GET') {
        res.writeHead(200, sseHeaders());
        const stopKeepalive = startSseKeepalive(res, { intervalMs: keepaliveIntervalMs });
        // A run parked on an approval emits nothing at all, so the stream has
        // to prove it is alive (above) and a viewer who has left has to be let
        // go. Iterating to the end of a run kept the subscription alive for
        // every second of it — indefinitely for a run that is only waiting for
        // a decision, however many phones had already navigated away.
        //
        // Releasing it is this signal, not a `return()` on the stream: the event
        // log's generator re-parks at a fresh await on every loop, so a return
        // queued behind an in-flight `next()` is never honoured and the waiter
        // would sit in the log until the run happened to emit again.
        const subscription = new AbortController();
        res.once('close', () => subscription.abort());
        const closed = new Promise((resolve) => res.once('close', resolve));
        try {
          const subscriber = environmentService
            .events(decodeURIComponent(runEvents[2]), { signal: subscription.signal })[Symbol.asyncIterator]();
          for (;;) {
            const next = await Promise.race([subscriber.next(), closed.then(() => CLOSED_STREAM)]);
            if (next === CLOSED_STREAM || next.done) break;
            if (res.destroyed || res.writableEnded) break;
            res.write(`data: ${JSON.stringify(next.value)}\n\n`);
          }
        } catch (error) {
          if (!res.destroyed && !res.writableEnded) {
            res.write(`data: ${JSON.stringify({ type: 'run.failed', payload: { message: error.message } })}\n\n`);
          }
        } finally {
          subscription.abort();
          stopKeepalive();
          res.end();
        }
        return;
      }

      const runCancel = pathname.match(/^\/v1\/environments\/([^/]+)\/runs\/([^/]+)\/cancel$/);
      if (runCancel && method === 'POST') {
        const result = await environmentService.cancel(decodeURIComponent(runCancel[2]));
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      const runApprove = pathname.match(/^\/v1\/environments\/([^/]+)\/runs\/([^/]+)\/approve$/);
      if (runApprove && method === 'POST') {
        const body = (await readJsonBody(req, { maxBytes: AUTH_MAX_BODY_BYTES })) ?? {};
        const result = await environmentService.approve(
          decodeURIComponent(runApprove[2]),
          body.approvalId,
          body.decision,
        );
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      // /v1/models - provider-owned live or labeled LKG/bootstrap catalogs
      if (pathname === '/v1/models' && method === 'GET') {
        // A backend owns its own catalog (ADR-0003); asking for one by id
        // must return only that catalog, never the Gate's provider list.
        // A Bot names its environment the same way, so a Bot's model list is
        // that Bot's own catalogue. `bot=` used to be ignored here: a Bot's
        // picker was handed the Gate's provider catalogue, the operator pinned
        // a provider Hermes does not have, and every turn to that Bot failed
        // (2026-09-16).
        const requestedBackendId = url.searchParams.get('backendId');
        const requestedBotId = readBotId(url);
        // `?refresh=1` is the operator (or a caller that just fixed a provider)
        // saying they asked for it now. Everything else is answered from the
        // router's cache, which answers a stale copy immediately and refreshes
        // it behind the request -- see backend-model-route.mjs.
        const forceRefresh = url.searchParams.get('refresh') === '1';
        if (requestedBackendId || requestedBotId) {
          const scope = await resolveConversationScope(requestedBackendId, requestedBotId);
          if (!scope?.backend) return;
          const { backend, environmentId } = scope;
          try {
            // Read through the router's cache: an environment under its own id,
            // a Bot under its own key and through its own profile-scoped backend
            // (`forBot` answers `/p/<bot>`), so a Bot's copy can never be another
            // Bot's list. A Bot picker is the operator's everyday path, and an
            // uncached Hermes catalogue costs ~4 s per open. The routing lookup
            // only walks the environment roster, so it never sees the Bot keys.
            const catalogueId = requestedBotId ? `${environmentId}@bot:${requestedBotId}` : requestedBackendId;
            const catalogues = await modelRouter.cataloguesFor(
              [requestedBotId ? { id: catalogueId, read: () => backend.listModels() } : { id: catalogueId }],
              { refresh: forceRefresh },
            );
            // No copy and no answer means the read failed or overran its
            // bound. That is the 502 this route answered with before the
            // catalogue was cached — not an empty list, which would tell the
            // picker this environment serves nothing and say nothing about
            // why.
            if (!catalogues.has(catalogueId)) {
              throw new Error(
                requestedBotId
                  ? `Bot "${requestedBotId}" did not answer with a model list.`
                  : `Environment "${requestedBackendId}" did not answer with a model list.`,
              );
            }
            const models = catalogues.get(catalogueId);
            res.writeHead(200);
            res.end(JSON.stringify({
              object: 'list',
              data: curateModels(models.map((model) => ({
                ...model,
                object: 'model',
                ...(requestedBackendId ? { backendId: requestedBackendId } : {}),
                ...(requestedBotId ? { bot: requestedBotId } : {}),
              })), { health: modelHealth, scopeId: healthScopeId(environmentId, requestedBotId) }),
            }));
          } catch (error) {
            // The streaming branch above may already have sent headers.
            if (res.headersSent) {
              res.end();
              return;
            }
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message, code: 'backend_error' } }));
          }
          return;
        }

        const snapshots = await providerService.list();
        const allModels = [];
        for (const snapshot of snapshots) {
          // A disabled provider is asked nothing and answers nothing, so
          // offering its models only sends the picker somewhere that refuses.
          if (snapshot.readiness?.state === 'disabled') continue;
          const models = snapshot.catalog?.models?.length
            ? snapshot.catalog.models.map((model) => model.id)
            : state.providers.find((provider) => provider.id === snapshot.id)?.config.models ?? [];
          for (const modelId of models) {
            allModels.push({
              id: modelId,
              provider: snapshot.id,
              providerId: snapshot.id,
              label: modelId,
              object: 'model',
              catalogSource: snapshot.catalog?.source,
            });
          }
        }
        if (allModels.length === 0) {
          for (const provider of state.providers) {
            for (const modelId of provider.config.models || []) {
              allModels.push({
                id: modelId,
                provider: provider.id,
                providerId: provider.id,
                label: modelId,
                object: 'model',
              });
            }
          }
        }
        // Every model a native environment can reach, alongside direct
        // providers. Cold startup can be slow for a CLI environment, so let
        // independent backends load together while preserving catalog order.
        // Every backend owns a model list, so none is skipped here; a backend
        // that will not start is remembered by the manager and costs one attempt
        // per backoff window rather than one 30s wait per request. The read
        // itself is the router's cached one, so the whole aggregate is answered
        // from whatever is already in hand — and an environment whose read
        // failed is left out of the map and so contributes no rows, exactly as
        // the per-descriptor try/catch this replaced did.
        const descriptors = await backendManager.list().catch(() => []);
        const catalogues = await modelRouter
          .cataloguesFor(descriptors, { refresh: forceRefresh })
          .catch(() => new Map());
        const backendModels = descriptors.map((descriptor) =>
          (catalogues.get(descriptor.id) ?? []).map((model) => ({
            ...model, object: 'model', backendId: descriptor.id,
          })));
        for (const models of backendModels) allModels.push(...models);

        // Curation runs on every response, not on every read: a model that
        // started failing is hidden the next time the catalogue is asked for,
        // however fresh the copy behind it is. The Gate's own provider rows go
        // through the same pass and are hidden only by what a model IS (they
        // carry no provider metadata to merge on and no sign-in flag), plus the
        // failing-turn verdict IF one exists for their key — the provider path
        // (`chatViaProviderService` / `proxyChat`) records none today, so a Gate
        // provider model is never hidden for having refused here.
        res.writeHead(200);
        res.end(JSON.stringify({
          object: 'list',
          data: curateModels(allModels, { health: modelHealth }),
        }));
        return;
      }

      // /p/{provider}/v1/models - scoped provider models
      const scopedModelMatch = pathname.match(/^\/p\/([^\/]+)\/v1\/models$/);
      if (scopedModelMatch && method === 'GET') {
        const providerId = decodeURIComponent(scopedModelMatch[1]);
        const provider = state.providers.find((p) => p.id === providerId);

        if (!provider) {
          res.writeHead(404);
          res.end(JSON.stringify({
            error: 'Not Found',
            message: `Provider ${providerId} not found`,
          }));
          return;
        }

        const models = provider.config.models || [];
        const modelList = models.map((modelId) => ({
          id: modelId,
          provider: provider.id,
          label: modelId,
          object: 'model',
        }));

        res.writeHead(200);
        res.end(JSON.stringify({
          object: 'list',
          data: modelList,
        }));
        return;
      }

      // /v1/chat/completions - unscoped chat (resolves provider from model)
      if (pathname === '/v1/chat/completions' && method === 'POST') {
        const body = (await readJsonBody(req, { maxBytes: AUTH_MAX_BODY_BYTES })) ?? {};

        // A backend-addressed turn runs inside the native environment, which is
        // what gives it that platform's sessions, tools and approvals.
        // Naming a Bot is naming an environment, exactly as naming a backend
        // is. Gating this on `backendId` alone meant that once the app
        // correctly stopped pinning the thread's chat backend for Bot turns —
        // a Bot owns its own environment — every Bot message fell through to
        // the provider proxy below and came back as an upstream error from a
        // vendor that was never meant to serve it.
        const botForTurn = readBotId(url, body);
        // A turn that names no environment, no Bot, and a provider this Gate has
        // never heard of, is a client that lost the thread's scope: the provider
        // id it sent belongs to an environment's catalogue (`kilo` is a Hermes
        // provider, not one of ours). Ask the attached environments whether one
        // of them serves the model before this becomes a 404 — older APKs in the
        // field still send exactly this turn. Never for a provider the Gate owns:
        // that ambiguity is the client's scope to fix, not this route to guess.
        const gateOwnsProviderId = body.providerId ? await gateOwnsProvider(body.providerId) : false;
        const routedBackendId = body.backendId || botForTurn || gateOwnsProviderId
          ? undefined
          : await modelRouter.backendFor(body.model, body.providerId);
        if (body.backendId || botForTurn || routedBackendId) {
          const scope = await resolveConversationScope(body.backendId || routedBackendId, botForTurn);
          if (!scope?.backend) return;
          const { backend, environmentId } = scope;
          // The qualifier this turn's model is judged under: the environment
          // that answered it, and the Bot when there is one (a Bot is its own
          // Hermes profile, with its own provider keys), so a failure is only
          // ever held against the catalogue that offered the model. The
          // catalogue files its rows under the same scope (curateModels'
          // `scopeId`), and nothing here is filed under the Gate's own
          // providers' `gate` namespace.
          const healthKey = modelHealthKey(
            healthScopeId(environmentId, botForTurn),
            qualifiedModelId(body.model, body.providerId),
          );
          try {
            const text = lastUserText(body.messages);
            const model = body.model ? parseQualifiedModel(body.model) : undefined;
            // The model is parsed BEFORE the session exists so a session this
            // turn has to open is born pinned to it. A Hermes session's model
            // is fixed at creation, so a session opened bare answers on the
            // host default for the rest of its life and the per-turn `model`
            // below cannot override it — which is how a thread asked for one
            // model and was answered by another, and why the operator had to
            // pick a model, lose the session, and send again to be heard.
            const opened = body.sessionId ? null : await backend.createSession({ title: newThreadTitle(), model });
            const sessionId = body.sessionId ?? opened.id;
            // The turn just touched this session, so it is the newest row of the
            // Gate's own copy of the list — so the next list shows the thread at
            // the top without waiting on the query that costs 3-38 s. A turn is
            // not a read: it knows the id and the time, and passes only those,
            // because the index merges field by field and a field it invents
            // (a null title, a `started_at` of now) would overwrite what the
            // copy's own read measured.
            if (indexesSessions(backend)) {
              await sessionListIndex.upsert(sessionIndexKey(environmentId, botForTurn), {
                id: sessionId,
                last_active: Date.now(),
                ...(opened ? { title: opened.title } : {}),
                ...(model?.modelId ? { model: model.modelId } : {}),
              });
            }

            if (body.stream === true) {
              const streamed = await streamBackendTurn(backend, sessionId, { text, model }, res, {
                callerId,
                turnId: readTurnId(req.headers['x-versutus-turn-id']),
                inFlightTurns,
                keepaliveIntervalMs,
                detachedTurnMaxMs,
                recordOutcome: recordTurnOutcome,
                healthKey,
              });
              // A completed turn reports as a Bot reply (a cron routine
              // session classifies to `routine` inside the notifier). A turn
              // the phone stopped stays silent; a turn it walked away from
              // still reports, because that reply is the only notice it will get.
              if (streamed) {
                notifyPush({
                  trigger: 'final-response',
                  sessionId,
                  ...(botForTurn ? { botId: botForTurn } : {}),
                  turnId: nextTurnId(sessionId),
                  text: streamed,
                });
              }
              return;
            }

            const result = await backend.sendMessage(sessionId, { text, model });
            // A turn that failed upstream arrives as a NORMAL completion whose
            // whole assistant text is the error (backendUpstreamRefusal).
            // Answering it 200 would render the error as the Bot's speech;
            // it is a refusal, and it answers as one.
            const refusal = backendUpstreamRefusal(result?.text);
            if (refusal) {
              // A phone that has gone is not evidence about the model.
              if (!res.destroyed) recordTurnOutcome(healthKey, { text: refusal });
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: { message: refusal, code: 'upstream_error' } }));
              return;
            }
            const hasContent = Boolean(result?.text && result.text.trim())
              || Boolean(result?.message?.tool_calls?.length);
            if (!hasContent) {
              // Same failure the streaming path guards against: the backend
              // says the turn is done, but there is nothing to show for it.
              if (!res.destroyed) recordTurnOutcome(healthKey, {});
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                error: { message: 'The backend completed the turn with no assistant content.', code: 'empty_turn' },
              }));
              return;
            }
            if (!res.destroyed) recordTurnOutcome(healthKey, { hasContent: true });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              id: `gate-${Date.now()}`,
              object: 'chat.completion',
              session_id: sessionId,
              ...modelReport(result?.runtime, model),
              choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
            }));
            if (result?.text && result.text.trim()) {
              notifyPush({
                trigger: 'final-response',
                sessionId,
                ...(botForTurn ? { botId: botForTurn } : {}),
                turnId: nextTurnId(sessionId),
                text: result.text,
              });
            }
          } catch (error) {
            // Thrown after the answer went out (the push notice, say): the turn
            // answered, so it is neither a failure nor a second response.
            if (res.headersSent) return;
            if (!res.destroyed) recordTurnOutcome(healthKey, { reason: error?.message, error });
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message, code: 'backend_error' } }));
          }
          return;
        }

        // Past this point the turn goes to one of the Gate's own providers, and
        // that needs a model to say which. With none named there is nothing to
        // route: this used to take the first model any provider advertised, so
        // a chat that had lost its Bot silently went to an arbitrary provider
        // and failed with that provider's error (2026-09-16).
        if (!body.model && !body.providerId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              message: 'This chat names no Bot, backend or model, so the Gate has nowhere to send it. Open a Bot or pick a model.',
              code: 'scope_required',
            },
          }));
          return;
        }

        const snapshots = await providerService.list();
        const advertised = snapshots.flatMap((snapshot) => (
          snapshot.catalog?.models ?? []
        ).map((model) => ({ providerId: snapshot.id, modelId: model.id })));
        for (const provider of state.providers) {
          for (const modelId of provider.config.models || []) {
            if (!advertised.some((entry) => entry.providerId === provider.id && entry.modelId === modelId)) {
              advertised.push({ providerId: provider.id, modelId });
            }
          }
        }
        if (!body.model && advertised[0]) {
          body.model = advertised[0].modelId;
        }
        const matches = advertised.filter((entry) => entry.modelId === body.model);
        if (body.providerId) {
          // Reached only for a provider the Gate owns, or one no environment
          // serves: the routing above answered the rest. What is left to say is
          // the whole picture — neither this Gate's providers nor any of its
          // environments has the model, so the way out is a different model and
          // not a re-send.
          if (!gateOwnsProviderId) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: {
                message: `Model "${body.model}" is not on this Gate's providers or any of its environments. Pick another model.`,
                code: 'unknown_provider',
              },
            }));
            return;
          }
          await dispatchChat(body.providerId, body, res);
          return;
        }
        if (matches.length > 1) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Model "${body.model}" is declared by multiple providers`, code: 'ambiguous_model' } }));
          return;
        }
        const providerId = matches[0]?.providerId
          ?? state.providers.find((item) => item.config.models.includes(body?.model))?.id;
        if (!providerId) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `No provider declares model "${body?.model}"`, code: 'unknown_model' } }));
          return;
        }
        await dispatchChat(providerId, body, res);
        return;
      }

      // /v1/chat/cancel - the user's Stop, as a fact the Gate can act on.
      //
      // A detached turn outlives the socket it was streamed on, so "the client
      // left" can no longer mean "stop the turn": that would throw away the
      // reply the phone is about to be notified about. The phone therefore
      // says Stop here FIRST and closes afterwards, and this is the one request
      // that ends a turn on purpose.
      if (pathname === '/v1/chat/cancel' && method === 'POST') {
        const body = (await readJsonBody(req, { maxBytes: AUTH_MAX_BODY_BYTES })) ?? {};
        const turnId = readTurnId(body?.turnId);
        // Scoped to the caller: one phone's Stop must never end another's turn.
        const turn = turnId ? inFlightTurns.get(`${callerId}:${turnId}`) : null;
        if (turn) turn.controller.abort();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ cancelled: Boolean(turn) }));
        return;
      }

      // /p/{provider}/v1/chat/completions - scoped chat
      const scopedChatMatch = pathname.match(/^\/p\/([^/]+)\/v1\/chat\/completions$/);
      if (scopedChatMatch && method === 'POST') {
        const body = await readJsonBody(req, { maxBytes: AUTH_MAX_BODY_BYTES });
        await dispatchChat(decodeURIComponent(scopedChatMatch[1]), body ?? {}, res);
        return;
      }

      // /v1/capabilities/rpc — also remounted under /p/{id} so a child
      // profile whose baseUrl is /p/{id} can POST the advertised path.
      const rpcMatch = pathname === '/v1/capabilities/rpc' || /^\/p\/[^/]+\/v1\/capabilities\/rpc$/.test(pathname);
      if (rpcMatch && method === 'POST') {
        const body = await readJsonBody(req, { maxBytes: AUTH_MAX_BODY_BYTES });
        const rpcMethod = body?.method;
        const params = body?.params ?? {};
        if (typeof rpcMethod !== 'string' || !rpcMethod) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'method must be a non-empty string', code: 'invalid_request' } }));
          return;
        }
        const handler = registryMethods[rpcMethod] ?? gatewayMethods[rpcMethod] ?? state.dispatch.get(rpcMethod);
        if (!handler) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Unknown method "${rpcMethod}"`, code: 'unknown_method' } }));
          return;
        }
        try {
          // deviceGrant is established once above for every authenticated
          // request on this route. Existing handlers take one argument and
          // ignore the second; only notifications.* (push-rpc.mjs) reads it,
          // via requireDevice(ctx), to bind a registration to the caller's
          // own paired identity rather than a client-supplied device id.
          // `bootstrap` marks a caller holding the Gate's own token and no grant;
          // push-rpc.mjs lets it register only in its own namespace.
          const result = await handler(params, {
            deviceId: deviceGrant?.deviceId ?? null,
            bootstrap: !deviceGrant,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ result }));
        } catch (error) {
          // requireDevice (push-rpc.mjs) sets .status/.code on a rejected
          // bootstrap-token call so it reaches the caller as 403
          // pairing_required rather than a generic 400 - preserve them when
          // a handler sets them, default to the prior behavior otherwise.
          res.writeHead(error.status ?? 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: error.message, code: error.code ?? 'rpc_error' } }));
        }
        return;
      }
    } catch (err) {
      if (err === invalidJsonBody) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: { message: err.message, code: 'bad_json' } }));
        return;
      }
      if (err === bodyTooLarge) {
        // The request stream is destroyed only after the 413 has flushed:
        // destroying it first would take the socket (and the response) with
        // it, and the caller would see a reset instead of the verdict.
        res.writeHead(413);
        res.end(JSON.stringify({ error: { message: err.message, code: 'body_too_large' } }), () => {
          req.destroy();
        });
        return;
      }
      console.error('Request handler error:', err);
      // This is the last line of defence, so it must not be able to throw.
      // A streaming route (SSE chat, run events, terminal) has already
      // committed its status line by the time an error reaches here; calling
      // writeHead again raises ERR_HTTP_HEADERS_SENT *inside this catch*,
      // where nothing handles it -- which took the whole Gate down whenever a
      // client asked about a session that no longer existed.
      if (res.headersSent) {
        res.end();
        return;
      }
      try {
        res.writeHead(500);
        res.end(JSON.stringify({
          error: 'Internal Server Error',
          message: err.message,
        }));
      } catch {
        res.end();
      }
    }
  });

  // One media WebSocket per voice call, over the same HTTP server. M5 wires the
  // local engine for an `engine: 'local'` grant; the scripted engine still
  // drives tests and the phone smoke test (`VERSUTUS_VOICE_SCRIPTED=1`).
  const voiceAudit = createVoiceAudit({ dir: voicePaths().root });
  const voiceMedia = attachVoiceMediaSocket({
    server,
    deviceTokens,
    tokenStore,
    registry: voiceRpc.registry,
    log: (line) => console.log(line),
    audit: (summary) => voiceAudit.record(summary),
    createEngine: (session) => (
      session.engine === 'local' && !scriptedEngineEnabled()
        ? new LocalEngine({ paths: voicePaths() })
        : new ScriptedEngine()
    ),
    runTurn: (session, text, handlers) => runVoiceTurn(backendManager, session, text, handlers),
    // A turn whose phone went away runs to the end and its reply is pushed, the
    // same notice a completed chat turn gets: the words are already in the
    // thread, and this is how they reach a phone that is not on the call.
    notifyPush: (event) => notifyPush({
      ...event,
      turnId: event.turnId ?? nextTurnId(event.sessionId),
    }),
  });

  // Start listening immediately
  const gateObj = {
    token,
    get providers() {
      return state.providers;
    },
    port,
    async listen() {
      return new Promise((resolve, reject) => {
        server.listen(port, () => {
          const actualPort = server.address().port;
          gateObj.port = actualPort;
          resolve(actualPort);
        });
        server.on('error', reject);
      });
    },
    async close() {
      // A coalesced index write must not be lost to a restart: a delete the
      // operator just made would otherwise live only in this process, and the
      // next list would answer from the copy and show it again. Bounded, because
      // a filesystem that will not answer must not hold a shutdown open.
      await Promise.race([
        sessionListIndex.flush(),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, DEFAULT_SESSION_INDEX_FLUSH_MS);
          timer.unref?.();
        }),
      ]);
      // Kill any live shells before the listener goes away, or they outlive it,
      // and end their streams or `server.close()` waits on them forever.
      terminalSessions.closeAll();
      for (const stream of [...terminalStreams]) {
        terminalStreams.delete(stream);
        try { stream.end(); } catch { /* already gone */ }
      }
      // Detached turns are still holding their request handlers, so the same
      // rule applies to them: a restart is a named end, not a wait.
      for (const turn of [...inFlightTurns.values()]) {
        clearTimeout(turn.timer);
        turn.controller.abort();
        inFlightTurns.clear();
      }
      return new Promise((resolve, reject) => {
        // A restart is a clean, named end for every live call, not a drop.
        voiceMedia.endAll?.('gate-restart');
        voiceMedia.close();
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };

  // Reload archived run history before the first request can arrive: a
  // replaying phone must find the runs that finished under the previous
  // process, not an empty list.
  await environmentService.init();

  // Start listening
  await gateObj.listen();

  return gateObj;
}
