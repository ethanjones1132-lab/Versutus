// ─── One turn runner behind typed and spoken turns ───────────────────────
// A typed chat turn (`/v1/chat/completions` SSE) and a spoken voice turn run
// the same backend turn. Both subscribe before sending so no opening delta is
// lost, surface reply text and tool calls as they arrive, and agree on what
// "the turn produced something" means, so a silent turn is an error rather
// than a clean finish.

const NOOP = () => {};
const EVENT_FEED_READY_MS = 3000;
const TELEMETRY_WARNING = 'Live thinking and tool activity unavailable for this turn.';

// There is deliberately no default bound on how long a turn may be silent.
//
// A default was tried and reverted. The 2026-09-19 incident is why: Hermes took
// two and a half minutes to answer under database contention, and that turn was
// valid the whole time — it produced a correct answer for a caller who had
// already been given a "still thinking" banner. A bound on silence cannot tell
// that from a hang, because from here they look identical: the final reached
// the Gate at 19:09:21/23, `sendMessage` was invoked, and nothing came back.
// So a sixty-second default took that reply with it, and it took the typed chat
// path's replies too, since both paths share this runner and neither asked for
// a cutoff. Hermes already holds the same line at the transport layer: a turn
// "legitimately runs for minutes", and only small metadata reads are bounded.
//
// Silence is therefore not evidence of anything, and a shared function that
// judges a turn by it will be wrong about some caller. Bounding a turn is the
// caller's decision, so the bound is opt-in (`stallTimeoutMs`) and off by
// default. What stays here is what a caller can act on without guessing: the
// stage telemetry naming how far the turn got, and cancellation that ends a
// turn the moment the caller lets go of it.
export const TURN_STALL_TIMEOUT_MS = 0;

/** The named failure a wedged backend earns, with the step it blocked on. */
export class BackendStallError extends Error {
  constructor(blockedOn, elapsedMs) {
    super('The turn stalled: the backend accepted it but produced no reply or activity.');
    this.name = 'BackendStallError';
    this.code = 'backend_stall';
    this.blockedOn = blockedOn;
    this.elapsedMs = elapsedMs;
  }
}

function toolDetail(value) {
  if (value === undefined) return '';
  try {
    return (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 2048);
  } catch {
    return '';
  }
}

/**
 * The model that actually answered, alongside the one the caller asked for.
 *
 * Backends are allowed to substitute — Hermes does it silently through
 * `fallback_providers` — and they report it in a runtime block. Reporting only
 * the request would keep repeating the operator's own choice back at them.
 * Absent runtime means the backend cannot tell us: say what was asked.
 */
export function modelReport(runtime, requested) {
  const ran = runtime?.model ?? requested?.modelId;
  const asked = runtime?.requested?.model ?? requested?.modelId;
  const report = {};
  if (ran) report.model = ran;
  if (asked) report.requested_model = asked;
  if (runtime?.provider) report.provider = runtime.provider;
  return report;
}

/**
 * Relay an OpenAI-shaped upstream stream, reporting what the caller cares
 * about. Payloads pass through unchanged -- Hermes and the Gate write the same
 * chunk shape, so translating would only add a place to get it wrong. `[DONE]`
 * is held back so the caller writes exactly one terminator, and unparseable
 * frames are forwarded rather than dropped.
 *
 * The OpenAI SSE contract ends a turn with `data: [DONE]` or a chunk carrying
 * a `finish_reason`. A body that just stops delivering frames is a turn cut
 * off mid-flight: it is rejected as truncated rather than reported as a
 * complete reply, because handing the caller half an answer it believes is
 * whole is worse than telling it the turn failed, and re-sending it would run
 * a turn the upstream may already have accepted.
 *
 * @returns whether anything the user could see came through.
 * @throws {Error & { code: 'stream_truncated' }} when the stream reaches EOF
 *   with no terminal frame and the caller has not aborted.
 */
async function relayStreamingTurn(upstream, { onDelta, onToolCall, onChunk, onProgress = NOOP, signal }) {
  const reader = upstream.body?.getReader?.();
  if (!reader) return false;

  // A read on a stream that has gone quiet never returns on its own, so an
  // aborted relay parked on one would hold the connection open for whoever
  // else wants it. Cancelling on abort releases the pending read *and* the
  // socket behind it, which is what lets the caller hanging up actually end
  // the turn instead of leaving a read outstanding behind it. It is fired and
  // forgotten, and best-effort: a cancel that is absent, throws synchronously,
  // or rejects must not park the relay or escape as the turn's failure.
  const release = () => {
    try {
      Promise.resolve(reader.cancel?.()).catch(() => undefined);
    } catch {
      // A cancel that throws synchronously has released all it can already.
    }
  };

  // The abort has to reach the relay's own read, not just the runner racing it
  // from outside: a read left pending behind a finished turn is a leaked read
  // and a leaked socket. `abortRead` wakes the awaited read the moment the
  // caller hangs up, whether or not the reader's own cancel cooperates.
  let wakeOnAbort = NOOP;
  const abortRead = new Promise((resolve) => { wakeOnAbort = resolve; });
  const onAbort = () => { release(); wakeOnAbort(); };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  const decoder = new TextDecoder();
  let buffer = '';
  let sawContent = false;
  let terminal = false;

  const aborted = () => Boolean(signal?.aborted);

  const handleFrame = (frame) => {
    // A batch can land in the same turn as the caller hanging up; no callback
    // may cross the wire after the abort that ended the turn.
    if (aborted()) return;
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .join('\n');
    if (!data) return;
    if (data === '[DONE]') {
      terminal = true;
      return;
    }

    onChunk(data);
    // `onChunk` is a caller callback like the rest: one that aborts mid-frame
    // owns the end of the turn, and nothing it aborted may be reported after.
    if (aborted()) return;
    try {
      const choice = JSON.parse(data)?.choices?.[0];
      const delta = choice?.delta;
      if (delta?.content) {
        sawContent = true;
        onDelta(delta.content);
        if (aborted()) return;
      }
      if (delta?.tool_calls?.length) {
        sawContent = true;
        for (const call of delta.tool_calls) {
          if (aborted()) return;
          onToolCall({ index: call.index ?? 0, name: call.function?.name, callId: call.id });
          if (aborted()) return;
        }
      }
      // A finish_reason chunk is the other supported terminal the contract
      // allows; its content (if any) is reported before the turn is closed.
      if (choice?.finish_reason) terminal = true;
    } catch {
      // Opaque frame: relayed verbatim, nothing to report to the caller.
    }
  };

  const drainFrames = () => {
    let index;
    while (!aborted() && !terminal && (index = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      handleFrame(frame);
    }
  };

  try {
    for (;;) {
      if (aborted()) return sawContent;
      // Race the read against the abort so a relay parked on a quiet stream
      // returns the instant the caller hangs up, instead of leaving the read
      // behind for the outer runner's race to abandon.
      const read = await Promise.race([reader.read(), abortRead]);
      if (aborted()) return sawContent;
      if (read?.done) break;
      const value = read?.value;
      onProgress();
      if (aborted()) return sawContent;

      buffer += decoder.decode(value, { stream: true });
      // Normalise CRLF framing to the LF the parser splits on. Frames written
      // with `\r\n\r\n` separators would otherwise never be found and would
      // silently disappear.
      buffer = buffer.replace(/\r\n/g, '\n');
      drainFrames();
      // A terminal frame ends the turn. There is nothing after it worth
      // reading, and waiting for EOF would park on a stream whose sender keeps
      // the socket open past its own terminator.
      if (terminal) {
        release();
        return sawContent;
      }
    }

    // Flush whatever the decoder held back and parse a final frame that has no
    // trailing blank line, so a terminal delivered at EOF is still honoured.
    buffer += decoder.decode();
    buffer = buffer.replace(/\r\n/g, '\n');
    drainFrames();
    if (!aborted() && buffer.replace(/\n+$/, '').length > 0) handleFrame(buffer);

    if (aborted()) return sawContent;
    if (!terminal) {
      const error = new Error('The upstream relay stream ended before its terminal frame.');
      error.code = 'stream_truncated';
      error.cause = new Error('EOF');
      throw error;
    }
    return sawContent;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Whether a `sendMessageStreaming` refusal means the backend cannot stream at
 * all, rather than that the turn failed. A 404 (unknown route) or 501
 * (unimplemented) is an answer about the endpoint, so a backend that predates
 * streaming can still be served by `sendMessage`; an explicit
 * `stream_unsupported` code counts even without a status. Anything else -- a
 * timeout, a 5xx, a dropped connection -- may already have been accepted, and
 * re-sending the turn would run it twice.
 */
function isStreamUnsupported(error) {
  if (error?.code === 'stream_unsupported') return true;
  return error?.status === 404 || error?.status === 501;
}

/**
 * Run one backend turn, reporting each visible piece through callbacks.
 *
 * @param {object} backend A CLI backend (sendMessage/streamEvents, or the
 *   one-call sendMessageStreaming Hermes uses).
 * @param {string} sessionId
 * @param {{ text: string, model?: object }} input
 * @param {{
 *   onDelta?: (text: string) => void,
 *   onToolCall?: (call: { index: number, name?: string, callId?: string }) => void,
 *   onApproval?: (approval: object) => void,
 *   onChunk?: (data: string) => void,
 *   onStage?: (stage: { stage: string, elapsedMs: number, [key: string]: unknown }) => void,
 *   signal?: AbortSignal,
 *   stallTimeoutMs?: number,
 * }} handlers `onChunk` carries the raw OpenAI-shaped payload for callers that
 *   relay bytes verbatim; `onDelta`/`onToolCall`/`onApproval` are the parsed
 *   events a voice loop consumes. `onStage` is best-effort telemetry that names
 *   how far the turn got, so a silent turn can be attributed to a step rather
 *   than reported only as "no reply". `signal` ends the turn the moment the
 *   caller lets go of it, and always wins. `stallTimeoutMs` optionally bounds
 *   the wait for the next sign of life (0, the default, waits as long as the
 *   caller allows) — see `TURN_STALL_TIMEOUT_MS` for why it is not on.
 * @returns {Promise<{ hasContent: boolean, report: object, aborted?: boolean }>}
 * @throws {BackendStallError} only when a caller opts in with `stallTimeoutMs`
 *   and the backend then goes silent for that long. It never fires on its own.
 */
export async function runBackendTurn(backend, sessionId, { text, model } = {}, {
  onDelta = NOOP,
  onToolCall = NOOP,
  onApproval = NOOP,
  onChunk = NOOP,
  onStage = NOOP,
  attempt,
  backendId,
  signal,
  stallTimeoutMs = TURN_STALL_TIMEOUT_MS,
} = {}) {
  // The caller owns the outer signal; this controller lets the runner stop the
  // event subscription once the turn is done even though it cannot abort the
  // caller's signal itself.
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });

  // The turn is the caller's to reclaim. A backend function may or may not
  // honour the signal it is handed — `sendMessage` (Codex, OpenCode) awaits its
  // own turn with an internal timeout, and `sendMessageStreaming` (Hermes) hands
  // back a body that can simply stop delivering frames. If the runner only
  // awaited them, a mute or hang-up would leave it parked until that inner
  // timeout, and the socket's `turnTimeoutMs` would later fire `replyFailed`
  // into a call that had already left. Race every backend promise against the
  // caller's abort: the aborted outcome is the turn being over, and the socket's
  // own abort path settles the prompt.
  const ABORTED_OUTCOME = Object.freeze({ hasContent: false, report: {}, aborted: true });
  const aborted = new Promise((resolve) => {
    const settle = () => resolve(ABORTED_OUTCOME);
    if (controller.signal.aborted) settle();
    else controller.signal.addEventListener('abort', settle, { once: true });
  });

  // ─── Stage telemetry and the opt-in stall bound ─────────────────────────
  // The stage stages below are the part of this a caller can act on without
  // guessing: they name how far a turn got, so a call that ends with nothing
  // to show is attributable to a step instead of being only "no reply". The
  // bound is a caller opt-in and off by default — see
  // `TURN_STALL_TIMEOUT_MS` — and every sign of life (a feed event, a byte off
  // the reply stream, an approval) re-arms it, so only true silence trips it.
  const stage = (name, extra = {}) => {
    try {
      onStage({
        stage: name,
        elapsedMs: handoffAt ? Date.now() - handoffAt : 0,
        ...(attempt === undefined ? {} : { attempt }),
        ...(backendId === undefined ? {} : { backend: backendId }),
        ...extra,
      });
    } catch {
      // Telemetry is a witness, never a failure mode.
    }
  };
  let handoffAt = 0;
  let blockedOn = 'the backend turn';
  // Which path the turn took, so every stage can name it; `accepted` is only
  // ever emitted with evidence (the backend answered, or the feed proved it was
  // working after the send), never merely because the runner reached the send.
  let turnPath = 'whole-turn';
  let sent = false;
  let accepted = false;
  const accept = () => {
    if (!sent || accepted) return;
    accepted = true;
    stage('turn.accepted', { path: turnPath });
  };
  let stallTimer = null;
  let stalled = false;
  let emittedActivity = false;
  let rejectStall = NOOP;
  const stall = stallTimeoutMs > 0
    ? new Promise((_resolve, reject) => { rejectStall = reject; })
    : null;
  // The bound can fire while the turn finishes on its own; mark the rejection
  // handled so a healthy turn is not reported as an unhandled rejection.
  stall?.catch(NOOP);
  const armStall = (step) => {
    if (!stall || stalled) return;
    if (!handoffAt) handoffAt = Date.now();
    if (step) blockedOn = step;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      const error = new BackendStallError(blockedOn, Date.now() - handoffAt);
      stage('turn.stalled', { blockedOn, timeoutMs: stallTimeoutMs });
      // Reject before aborting: aborting settles the caller-abort race too, and
      // the stall error is the more specific reason the turn ended.
      rejectStall(error);
      controller.abort();
    }, stallTimeoutMs);
    stallTimer.unref?.();
  };
  const noteActivity = (step) => {
    if (!handoffAt) return;
    if (!emittedActivity) {
      emittedActivity = true;
      stage('turn.activity');
    }
    if (stall && !stalled) armStall(step);
  };
  const clearStall = () => {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };
  const raceStop = (promise) => (stall
    ? Promise.race([promise, aborted, stall])
    : Promise.race([promise, aborted]));

  try {
    // Hermes sends and streams in one POST, which does not fit the
    // subscribe-then-send shape below, so it is handled as its own path.
    if (typeof backend.sendMessageStreaming === 'function') {
      // A backend that cannot stream at all hands the turn to the whole-turn
      // path below, which needs this controller live. Every other ending is
      // this branch's own, and a bound still armed when the turn is over would
      // fire against a call that has already left.
      let fellThrough = false;
      try {
        turnPath = 'streaming';
        handoffAt = Date.now();
        armStall('the streaming request');
        sent = true;
        stage('turn.send', { path: turnPath });
        let upstream = null;
        try {
          upstream = await raceStop(
            backend.sendMessageStreaming(sessionId, { text, model }, controller.signal),
          );
        } catch (error) {
          upstream = null;
          // The stall bound is the reason the turn ended, not the caller walking
          // away; surface it before the abort check below mislabels it. The
          // streaming POST may have been accepted even though the stream failed
          // -- a timeout or 5xx after Hermes read the body would run the same
          // prompt twice if it were re-sent below. Only a refusal that says "this
          // backend cannot stream at all" may fall through to the whole-turn
          // path; every other failure propagates.
          if (error instanceof BackendStallError) throw error;
          if (controller.signal.aborted) return ABORTED_OUTCOME;
          if (!isStreamUnsupported(error)) throw error;
        }

        if (upstream === ABORTED_OUTCOME) return ABORTED_OUTCOME;
        if (upstream) {
          // The POST answered with a body: that is the backend accepting the
          // turn, and the first truthfully-earned acceptance.
          accept();
          // The POST is home: the wait is now the reply stream delivering
          // frames. Raced against the caller's abort as well as the bound --
          // unlike the POST above, this wait has no timeout of its own, so a
          // caller hanging up is the only thing that can end it. A relay
          // abandoned here is released on abort, so the read it is parked on
          // and the connection under it both go away with the call.
          armStall('the reply stream');
          const relay = relayStreamingTurn(upstream, {
            onDelta,
            onToolCall,
            onChunk,
            onProgress: () => noteActivity('the reply stream'),
            signal: controller.signal,
          });
          // The race below can settle before the relay does, and nothing is left
          // listening then. Mark a late failure handled so a relay abandoned by a
          // cancelled turn is not reported as an unhandled rejection; a relay
          // that fails first still propagates through the race.
          relay.catch(NOOP);
          const hasContent = await raceStop(relay);
          if (hasContent === ABORTED_OUTCOME) return ABORTED_OUTCOME;
          // A released relay can now return before the abort race's own
          // settlement is observed, so the settled signal is the last word: a
          // caller who hung up gets an aborted turn, never a content flag.
          if (controller.signal.aborted) return ABORTED_OUTCOME;
          stage('turn.response', { path: turnPath });
          stage('turn.settled');
          return { hasContent, report: {} };
        }
        fellThrough = true;
      } finally {
        clearStall();
        if (!fellThrough) controller.abort();
      }
    }

    let toolIndex = 0;
    const seenTools = new Map();
    // A tool call is real turn activity with no closing text of its own -- only
    // a turn where *neither* text nor a tool ever happened counts as empty.
    let sawContent = false;
    // The answer text the feed actually delivered, to reconcile against the
    // send's own answer once it returns.
    let streamedText = '';

    const startTool = (name, callId, input) => {
      if (seenTools.has(callId)) return seenTools.get(callId);
      sawContent = true;
      const index = toolIndex++;
      const detail = toolDetail(input);
      const tool = { index, name, callId, startedAt: Date.now(), detail };
      seenTools.set(callId, tool);
      onToolCall({ index, name, callId, ...(detail ? { detail } : {}) });
      onChunk(JSON.stringify({
        choices: [{ delta: { tool_calls: [{
          index, id: callId, function: { name }, status: 'running',
          ...(detail ? { detail } : {}),
        }] } }],
      }));
      return tool;
    };

    const handleEvent = (event) => {
      if (controller.signal.aborted || !event) return;
      // An event after the send is the backend working on this turn: the first
      // honest evidence the turn was accepted.
      accept();
      // Any event at all — reasoning, a tool frame, text — is the backend
      // proving it is alive, and pushes the stall bound out.
      noteActivity('the backend turn');
      if (event.type === 'message.delta' && event.payload?.text) {
        sawContent = true;
        streamedText += event.payload.text;
        onDelta(event.payload.text);
        onChunk(JSON.stringify({ choices: [{ delta: { content: event.payload.text } }] }));
        return;
      }
      if (event.type === 'message.reasoning.delta' && event.payload?.text) {
        onChunk(JSON.stringify({ choices: [{ delta: { reasoning_content: event.payload.text } }] }));
        return;
      }
      if (event.type === 'tool.started' && event.payload?.name) {
        const callId = event.payload.callId ?? `gate-tool-${toolIndex}`;
        if (seenTools.has(callId)) return;
        startTool(event.payload.name, callId, event.payload.input);
        return;
      }
      if (event.type === 'tool.progress') {
        const payload = event.payload ?? {};
        const tool = payload.callId
          ? seenTools.get(payload.callId)
          : [...seenTools.values()].reverse().find((item) => item.name === payload.name);
        const hasSnapshot = payload.snapshot === true
          && (payload.input !== undefined || payload.detail !== undefined);
        if (!tool && hasSnapshot && payload.name) {
          const callId = payload.callId ?? `gate-tool-${toolIndex}`;
          startTool(payload.name, callId, payload.input ?? payload.detail);
          return;
        }
        if (!tool) return;
        if (hasSnapshot) {
          const detail = toolDetail(payload.input ?? payload.detail);
          if (!detail || detail === tool.detail) return;
          tool.detail = detail;
        } else {
          if (!payload.text) return;
          tool.detail = `${tool.detail}${payload.text}`.slice(-2048);
        }
        onToolCall({ index: tool.index, name: tool.name, callId: tool.callId, status: 'running', detail: tool.detail });
        onChunk(JSON.stringify({
          choices: [{ delta: { tool_calls: [{
            index: tool.index, id: tool.callId, status: 'running', detail: tool.detail,
          }] } }],
        }));
        return;
      }
      if (event.type === 'tool.output') {
        // Output chunks are progress, not completion. Codex emits them under
        // this same event type without a call id; only a terminal result may
        // mark the card done.
        const callId = event.payload?.callId;
        const tool = callId ? seenTools.get(callId) : null;
        if (!tool) return;
        if (typeof event.payload?.output === 'string' && event.payload.output) {
          tool.detail = event.payload.output.slice(-2048);
        }
        const status = event.payload?.isError || ['error', 'failed'].includes(event.payload?.status)
          ? 'error' : 'complete';
        const durationMs = Math.max(0, Date.now() - tool.startedAt);
        onToolCall({ index: tool.index, name: tool.name, callId, status, durationMs,
          ...(tool.detail ? { detail: tool.detail } : {}) });
        onChunk(JSON.stringify({
          choices: [{ delta: { tool_calls: [{
            index: tool.index, id: callId, function: { name: tool.name }, status, durationMs,
            ...(tool.detail ? { detail: tool.detail } : {}),
          }] } }],
        }));
        seenTools.delete(callId);
        return;
      }
      if (event.type === 'approval.required') onApproval(event.payload);
    };

    // Stdio/HTTP backends subscribe before sending. Claude Code is one
    // process per turn and delivers events through sendMessage's callback.
    // The hand-off clock starts now: an event from the opening feed is already
    // the backend working, even before `sendMessage` is invoked.
    handoffAt = Date.now();
    const subscription = typeof backend.streamEvents === 'function'
      ? backend.streamEvents(sessionId, handleEvent, controller.signal)
      : null;
    let warned = false;
    const warnTelemetry = () => {
      if (warned || controller.signal.aborted) return;
      warned = true;
      onChunk(JSON.stringify({ telemetry: { status: 'degraded', message: TELEMETRY_WARNING } }));
    };
    // A feed that fails is telemetry, not a turn failure, so the rejection is
    // handled where the subscription is born. Nothing awaits it afterwards —
    // see the finally below for why the turn must not.
    Promise.resolve(subscription).catch(() => { warnTelemetry(); });

    try {
      // HTTP event feeds become usable only after their GET answers. A turn
      // sent before that point loses its first thinking/tool frames.
      if (subscription?.ready) {
        let timer;
        const feedOpen = Promise.race([
          subscription.ready,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('event feed did not open')), EVENT_FEED_READY_MS);
            timer.unref?.();
          }),
        ]);
        try {
          // The feed is a courtesy to the turn, not the turn itself. Raced
          // against the caller's abort like every other wait here: a phone that
          // hangs up while the GET is still opening is released at once instead
          // of sitting out the open window, and a turn the caller has already
          // walked away from is not reported as a feed it never got to use.
          const opened = await Promise.race([feedOpen, aborted]);
          if (opened === ABORTED_OUTCOME) return ABORTED_OUTCOME;
          stage('feed.ready');
        } catch {
          // Keep the answer path available and tell the client its live
          // activity feed could not be trusted for this turn.
          warnTelemetry();
          stage('feed.unavailable');
        } finally {
          clearTimeout(timer);
        }
      }
      if (controller.signal.aborted) return ABORTED_OUTCOME;
      // Raced against the caller's abort and the stall bound: a backend whose
      // turn promise observes neither (Codex/OpenCode await their own turn)
      // must not keep the runner parked after the caller left or the backend
      // went quiet.
      armStall('the backend turn');
      sent = true;
      stage('turn.send', { path: turnPath });
      // The signal travels with the turn, not only around it. A backend whose
      // turn *is* a process (Claude Code spawns `claude --print` and parks on
      // its exit) cannot be reclaimed by the race below: that race ends the
      // HTTP turn and leaves the agent running. Backends that take no signal
      // ignore the extra key, and their turn is still released by the race.
      const result = await raceStop(backend.sendMessage(
        sessionId, { text, model, signal: controller.signal },
        typeof backend.streamEvents === 'function' ? undefined : handleEvent,
      ));
      if (result === ABORTED_OUTCOME) return ABORTED_OUTCOME;
      // The send answered, or the feed already proved the backend was working:
      // either is evidence of acceptance, and neither is assumed at send time.
      accept();

      // The send and the feed race. OpenCode's POST can answer while the bus
      // still holds the reply's last parts, and the abort in the finally below
      // then cut them off -- once the whole answer went missing although
      // OpenCode had stored it (a tool call or an echoed prompt had already
      // counted as content, so the back-fill below never ran). A finished turn
      // must not wait on its feed, so instead: when the send's own answer
      // extends what the feed delivered, send the missing tail now, exactly
      // once -- the feed is stopped right after, with no await in between, so
      // its late copy of the same text can never land on top.
      const finalText = typeof result?.text === 'string' ? result.text : '';
      if (subscription && streamedText && finalText.length > streamedText.length
        && finalText.startsWith(streamedText)) {
        const missing = finalText.slice(streamedText.length);
        streamedText = finalText;
        onDelta(missing);
        onChunk(JSON.stringify({ choices: [{ delta: { content: missing } }] }));
      } else if (subscription && !streamedText && sawContent && finalText.trim()) {
        // Tools streamed but none of the answer did: the answer is still owed.
        streamedText = finalText;
        onDelta(finalText);
        onChunk(JSON.stringify({ choices: [{ delta: { content: finalText } }] }));
      }

      const hasContent = sawContent
        || Boolean(result?.text && result.text.trim())
        || Boolean(result?.message?.tool_calls?.length);

      // A backend whose `streamEvents` is a no-op finishes the turn with real
      // text that never reached the wire. Send it as one delta rather than
      // dropping it -- and only when nothing streamed, so a backend that does
      // emit events is not echoed twice.
      if (!sawContent && result?.text && result.text.trim()) {
        onDelta(result.text);
        onChunk(JSON.stringify({ choices: [{ delta: { content: result.text } }] }));
      }

      stage('turn.response', { path: turnPath });
      stage('turn.settled');
      return { hasContent, report: modelReport(result?.runtime, model) };
    } finally {
      clearStall();
      // The subscription is stopped, never awaited. It may ignore the signal
      // and never settle, and a turn that is already over — `sendMessage` has
      // answered, or the caller has hung up — cannot be held in here by a feed
      // that will not answer its own stop. Every event after the abort is
      // dropped by `handleEvent`, and a late rejection is handled where the
      // subscription was created, so there is nothing left to drain.
      controller.abort();
    }
  } catch (error) {
    // A failed turn keeps its stage and a safe cause (a code or name, never a
    // message that could carry the prompt), so the log can place the failure
    // without being a second place the turn's content can leak.
    stage('turn.failed', { path: turnPath, cause: error?.code ?? error?.name ?? 'error' });
    throw error;
  } finally {
    signal?.removeEventListener('abort', forwardAbort);
  }
}
