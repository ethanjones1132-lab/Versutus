// ─── The Gate media WebSocket: one socket and one call loop per call ──────
// `GET /v1/voice/stream?voiceSessionId=<id>` upgraded with the same device
// token the HTTP routes use. The session must belong to the calling device.
// Raw PCM16LE arrives as binary frames; the JSON control frames are the
// protocol module's phone frames. Nothing here writes audio to disk.
//
// The socket owns the pure call loop (`reduceVoiceSession`): every engine
// event, backend reply and phone control becomes a reducer event, and every
// effect the reducer names is run here — speak, cancel, mute, run the Bot
// turn, and send a phone frame. The turn runner is injected so a spoken turn
// and a typed turn share one implementation (M5 task 5.4).
//
// A call outlives its socket: a dropped phone detaches the call for
// `resumeTimeoutMs` (20 s), buffering outbound speech (up to 5 s); a phone that
// re-connects with the same `voiceSessionId` re-attaches to the live call, and
// one that does not ends it with reason `network` (M7 task 7.1).

import { WebSocketServer } from 'ws';

import { parsePhoneFrame, serializeFrame } from './protocol.mjs';
import { INITIAL_VOICE_SESSION, reduceVoiceSession } from './voice-session.mjs';

export const VOICE_STREAM_PATH = '/v1/voice/stream';
export const MAX_MEDIA_FRAME_BYTES = 64 * 1024;
export const NO_AUDIO_TIMEOUT_MS = 30_000;
export const RESUME_TIMEOUT_MS = 20_000;
export const AUDIO_BUFFER_MS = 5_000;
export const OUTPUT_SAMPLE_RATE = 24_000;
export const OUTPUT_CHANNELS = 1;
// How long a turn started on an early end survives before it is committed.
export const SPECULATION_WINDOW_MS = 600;
// How long consecutive transcript segments are gathered into one utterance
// before it is sent. A recognizer's `final` is a sentence-sized segment, not the
// end of what the person wants to say, so a turn started on the first segment
// answers a half-heard question; 0 commits every segment at once, which is the
// older one-final-one-turn behaviour. 1.8 s because a person thinking between
// sentences pauses 1-3 s (measured on a live call, 2026-10-02: finals 1.0-3.1 s
// apart); the recognizer's own turn judge already sits in front of this, so the
// hold only has to cover what it judged complete too early.
export const UTTERANCE_HOLD_MS = 1_800;
// How long after a turn was committed a final heard while it is still thinking
// counts as the same thought (so it merges into that turn) rather than a new one
// (so it waits for its own turn).
export const CONTINUATION_MS = 5_000;
// How long one Bot turn may run before the call names it failed and reopens,
// symmetric with the phone engine's reply watchdog: a backend that never
// answers must not park the call in thinking forever. Three minutes, not two:
// the host's backend (Hermes) has proven it can stall for 2.5 minutes under
// database contention and still answer (2026-09-19), and the banner now names
// a slow wait instead of sitting silent — so a stall that recovers completes
// the turn instead of failing it.
//
// This is the voice turn's only bound, and it belongs to the call rather than to
// the shared runner: `runBackendTurn` applies no cutoff of its own, because a
// bound on silence cannot tell a slow turn from a dead one and would take the
// slow ones down with it. So the voice call carries the window, and the runner
// hands the turn back the moment it ends — by finishing, or by the caller
// aborting, which is what this timer does.
export const TURN_TIMEOUT_MS = 180_000;

function rejectUpgrade(socket, status, message) {
  try {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  } catch {
    // the peer is already gone
  }
  socket.destroy();
}

/** The median of a call's per-turn latencies, in ms; null when none happened. */
function p50(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function attachVoiceMediaSocket({
  server,
  deviceTokens,
  tokenStore = null,
  registry,
  createEngine,
  runTurn,
  audit = null,
  log = () => {},
  now = () => Date.now(),
  noAudioTimeoutMs = NO_AUDIO_TIMEOUT_MS,
  resumeTimeoutMs = RESUME_TIMEOUT_MS,
  audioBufferMs = AUDIO_BUFFER_MS,
  turnTimeoutMs = TURN_TIMEOUT_MS,
  speculationWindowMs = SPECULATION_WINDOW_MS,
  utteranceHoldMs = UTTERANCE_HOLD_MS,
  continuationMs = CONTINUATION_MS,
} = {}) {
  const wss = new WebSocketServer({ noServer: true });
  const calls = new Map();

  server.on('upgrade', async (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }
    if (url.pathname !== VOICE_STREAM_PATH) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    const grant = await deviceTokens.verify(req.headers.authorization).catch(() => null);
    // A phone holding the Gate's own token has no grant; voice-rpc files its
    // sessions as `bootstrap:<id>`, and only those may be opened with it.
    const bootstrap = !grant && tokenStore
      ? await Promise.resolve(tokenStore.verify(req.headers.authorization)).catch(() => false)
      : false;
    if (!grant && !bootstrap) {
      log('voice.stream reject status=401 reason=unauthorized');
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    const voiceSessionId = url.searchParams.get('voiceSessionId');
    const session = voiceSessionId ? registry.get(voiceSessionId) : null;
    if (!session) {
      log(`voice.stream reject status=404 session=${voiceSessionId ?? 'missing'}`);
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    const owns = grant
      ? session.deviceId === grant.deviceId
      : typeof session.deviceId === 'string' && session.deviceId.startsWith('bootstrap:');
    if (!owns) {
      log(`voice.stream reject status=403 session=${session.voiceSessionId}`);
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    if (session.ended) {
      log(`voice.stream reject status=409 session=${session.voiceSessionId} reason=ended`);
      rejectUpgrade(socket, 409, 'Conflict');
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const existing = calls.get(session.voiceSessionId);
      if (existing && !existing.ended) {
        existing.attach(ws, { first: false });
        return;
      }
      const call = createCall(session, ws);
      calls.set(session.voiceSessionId, call);
    });
  });

  function createCall(session, firstWs) {
    const engine = createEngine(session, firstWs);
    log(`voice.stream open session=${session.voiceSessionId} engine=${session.engine}`);
    const maxBufferedAudioBytes = (audioBufferMs / 1000) * OUTPUT_SAMPLE_RATE * 2 * OUTPUT_CHANNELS;
    let ws = null;
    let ended = false;
    let endingNow = false;
    let call = INITIAL_VOICE_SESSION;
    const trace = {
      startedAt: now(),
      audioFrames: 0,
      audioBytes: 0,
      partials: 0,
      finals: 0,
      utterances: 0,
      queued: 0,
      continued: 0,
      speechChunks: 0,
      firstReplyAt: 0,
      // One sample per turn: how long the commit was followed by that turn's
      // first reply delta, and by its first speech chunk.
      replyLatencies: [],
      audioLatencies: [],
    };
    let turnAbort = null;
    let turnTimer = null;
    let holdTimer = null;
    let turnCommittedAt = 0;
    let turnFirstReplyAt = 0;
    let turnFirstAudioAt = 0;
    let speculative = null;
    // The transcript the socket confirmed on the engine's behalf, and how long it
    // may still be echoed by a `final` that was merely late: the worker emits
    // both `earlyEnd` and `final` for one utterance, so folding the late copy in
    // would send the same sentence twice. It is spent by any other transcript and
    // by the window itself, so a person who really does repeat themselves is
    // heard both times.
    let confirmed = null;
    // A speculative replacement starts a new turn on the same call, so a call
    // session id alone cannot tell the old turn's stages from the new one's.
    // Each startTurn gets its own attempt id, and every stage names it.
    let turnAttempts = 0;
    let resumeTimer = null;
    let audioTimer = null;
    let lastAudioAt = now();
    let turns = 0;
    let listeningMs = 0;
    let speakingMs = 0;
    let phaseSince = now();
    const buffer = [];
    let bufferedAudioBytes = 0;

    const api = { attach, end, get ended() { return ended; } };

    // The registry ends sessions from the outside too: a stale reservation
    // released as abandoned, a `voice.session.stop` that landed after the
    // phone's own teardown. The call has to end in that same turn, or it would
    // keep running beside the session that took its device — two media calls
    // for one device — until its own timers eventually noticed.
    const leaveRegistry = registry.onEnd?.((endedSession, reason) => {
      if (endedSession.voiceSessionId === session.voiceSessionId) end(reason);
    });

    const clearTurnTimer = () => {
      if (turnTimer) {
        clearTimeout(turnTimer);
        turnTimer = null;
      }
    };

    const clearHoldTimer = () => {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
    };

    const clearResumeTimer = () => {
      if (resumeTimer) {
        clearTimeout(resumeTimer);
        resumeTimer = null;
      }
    };
    const clearAudioTimer = () => {
      if (audioTimer) {
        clearInterval(audioTimer);
        audioTimer = null;
      }
    };
    const startAudioTimer = () => {
      // One call owns one audio timer. `audioTimer` is a single handle, so
      // arming over an existing one orphans that interval: the stale socket's
      // close handler ignores itself because `ws` is no longer it, and `end()`
      // clears only the newest. A second upgrade while the first socket is
      // still open — a half-open socket on Tailscale, which is exactly what the
      // resume window exists for — would then leak a 1 Hz timer per re-attach.
      clearAudioTimer();
      audioTimer = setInterval(() => {
        if (ws && now() - lastAudioAt > noAudioTimeoutMs) ws.close(1001, 'idle');
      }, Math.min(noAudioTimeoutMs, 1000));
      audioTimer.unref?.();
    };

    const flush = () => {
      if (!ws) return;
      for (const entry of buffer) {
        if (entry.binary) ws.send(entry.data, { binary: true });
        else ws.send(entry.data);
      }
      buffer.length = 0;
      bufferedAudioBytes = 0;
    };

    const sendFrame = (frame) => {
      if (ended) return;
      const data = serializeFrame(frame);
      if (ws) ws.send(data);
    };

    const sendAudio = (pcm) => {
      if (ended) return;
      if (ws) {
        ws.send(pcm, { binary: true });
        return;
      }
      if (bufferedAudioBytes + pcm.length > maxBufferedAudioBytes) return;
      buffer.push({ binary: true, data: pcm });
      bufferedAudioBytes += pcm.length;
    };

    const runEffect = (effect) => {
      switch (effect.kind) {
        case 'send':
          // Counted where the reducer decided to send it, so the line cannot
          // count a transcript the call would never have shown the phone.
          if (effect.frame.t === 'partial') trace.partials += 1;
          sendFrame(effect.frame);
          break;
        case 'sendAudio':
          sendAudio(effect.pcm);
          break;
        case 'engine.speak':
          engine.speak?.(effect.text, { gen: effect.gen, final: effect.final });
          break;
        case 'engine.cancelSpeech':
          engine.cancelSpeech?.(effect.gen);
          break;
        case 'engine.setMuted':
          engine.setMuted?.(effect.muted);
          break;
        // The reducer names when the person has stopped talking; the socket owns
        // the clock. One timer per call: re-arming replaces the running hold, so
        // a long utterance cannot leave a timer behind that commits it early.
        case 'hold.start':
          clearHoldTimer();
          if (!(effect.ms > 0)) break;
          holdTimer = setTimeout(() => {
            holdTimer = null;
            dispatch({ type: 'holdElapsed' });
          }, effect.ms);
          holdTimer.unref?.();
          break;
        case 'turn.run':
          if (speculative) {
            const entry = speculative;
            clearTimeout(entry.timer);
            if (entry.text === effect.text) {
              // `final` promotes the turn the early end already started.
              entry.committed = true;
              speculative = null;
              turns += 1;
              // The backend can answer before the final transcript arrives.
              // Deliver its buffered events only after the reducer is thinking.
              for (const event of entry.pending) dispatch(event);
              entry.pending.length = 0;
              break;
            }
            entry.controller.abort();
            speculative = null;
          }
          turns += 1;
          void startTurn(effect.text);
          break;
        case 'turn.cancel':
          if (speculative) {
            clearTimeout(speculative.timer);
            speculative = null;
          }
          turnAbort?.abort();
          turnAbort = null;
          break;
        // What the reducer decided about the speech, counted and named here: the
        // call log says what was sent, what waited and what merged, so a call
        // cannot look complete while speech was quietly folded into a reply.
        case 'utterance.commit':
          trace.utterances += 1;
          turnCommittedAt = now();
          turnFirstReplyAt = 0;
          turnFirstAudioAt = 0;
          log(
            `voice.utterance commit session=${session.voiceSessionId}`
            + ` chars=${effect.chars} finals=${effect.finals}`,
          );
          break;
        case 'utterance.merge':
          trace.continued += 1;
          log(`voice.final merged session=${session.voiceSessionId} chars=${effect.chars}`);
          break;
        case 'utterance.queue':
          trace.queued += 1;
          log(`voice.final queued session=${session.voiceSessionId} chars=${effect.chars}`);
          break;
        case 'audit':
          // The reducer names the end; the line carries counts and names only.
          audit?.({
            deviceId: session.deviceId,
            botId: session.thread?.botId ?? null,
            engine: session.engine,
            fellBackFrom: session.fellBackFrom ?? null,
            turns,
            utterances: trace.utterances,
            finals: trace.finals,
            partials: trace.partials,
            queued: trace.queued,
            continued: trace.continued,
            secondsListening: Math.round(listeningMs / 1000),
            secondsSpeaking: Math.round(speakingMs / 1000),
            p50FirstAudioMs: p50(trace.audioLatencies),
            p50FirstReplyMs: p50(trace.replyLatencies),
            error: effect.reason ?? null,
          });
          break;
        default:
          // Anything newer is inert here.
          break;
      }
    };

    const dispatch = (event) => {
      // The phone only hears "that turn could not be completed"; the host
      // log has to say why, or a wrong backend looks like a flaky model.
      if (event.type === 'replyFailed') {
        log(`voice.turn fail session=${session.voiceSessionId} reason=${event.message}`);
      }
      // One line per step a call takes, so "it never answered" can be placed:
      // no audio, no transcript, a transcript but no turn, or a turn with no
      // speech. Text is logged by length only; what was said stays off disk.
      // `finals` is what the engine heard; what was done with each one is
      // counted and logged by the reducer's decisions (below), so the two
      // reconcile on the end line instead of quietly disagreeing.
      if (event.type === 'final') {
        trace.finals += 1;
        log(`voice.final session=${session.voiceSessionId} chars=${String(event.text ?? '').length} afterMs=${now() - trace.startedAt}`);
      } else if (event.type === 'replyDelta') {
        if (turnCommittedAt && !turnFirstReplyAt) {
          turnFirstReplyAt = now();
          trace.replyLatencies.push(turnFirstReplyAt - turnCommittedAt);
        }
        if (!trace.firstReplyAt) {
          trace.firstReplyAt = now();
          log(`voice.reply first session=${session.voiceSessionId} afterMs=${trace.firstReplyAt - trace.startedAt}`);
        }
      } else if (event.type === 'speechAudio') {
        trace.speechChunks += 1;
        if (turnCommittedAt && !turnFirstAudioAt) {
          turnFirstAudioAt = now();
          trace.audioLatencies.push(turnFirstAudioAt - turnCommittedAt);
        }
      } else if (['bargein', 'userSpeechStart', 'skip', 'end', 'error', 'mute', 'unmute'].includes(event.type)) {
        log(`voice.event session=${session.voiceSessionId} type=${event.type}${event.code ? ` code=${event.code}` : ''}${event.message ? ` message=${event.message}` : ''}`);
      } else if (event.type === 'socketClosed') {
        log(
          `voice.end session=${session.voiceSessionId} reason=${event.reason}`
          + ` audioFrames=${trace.audioFrames} audioBytes=${trace.audioBytes} partials=${trace.partials}`
          + ` finals=${trace.finals} speechChunks=${trace.speechChunks} utterances=${trace.utterances}`
          + ` queued=${trace.queued} continued=${trace.continued} turns=${turns} phase=${call.phase}`,
        );
      }
      // The reducer keeps its own clocks out, so the socket stamps the time it
      // decided on and hands it over with the event.
      const at = now();
      const out = reduceVoiceSession(call, { ...event, nowMs: at });
      if (out.state.phase !== call.phase) {
        const elapsed = at - phaseSince;
        if (call.phase === 'listening' || call.phase === 'muted') listeningMs += elapsed;
        else if (call.phase === 'speaking') speakingMs += elapsed;
        phaseSince = at;
      }
      call = out.state;
      for (const effect of out.effects) runEffect(effect);
      // Every terminal path converges on `ending`; the socket's own end()
      // closes the WebSocket, frees the registry and deletes the call. Without
      // this a user hang-up left the call half-alive: the socket open, the
      // registry occupied, and a new start answered call_in_progress until the
      // client happened to close the socket. `endingNow` is the re-entry
      // guard: end() dispatches the terminal event itself.
      if (call.phase === 'ending' && !ended && !endingNow) end(call.endedReason ?? 'ended');
    };

    const startTurn = async (text, { speculative: isSpeculative = false } = {}) => {
      if (typeof runTurn !== 'function') {
        dispatch({ type: 'replyFailed', message: 'No backend is available for this call.' });
        return;
      }
      const attempt = String(++turnAttempts);
      const turnStartedAt = now();
      const controller = new AbortController();
      const entry = isSpeculative
        ? { text, controller, committed: false, pending: [], timer: null }
        : null;
      turnAbort = controller;
      // A backend that never answers must not park the call in thinking: the
      // turn is failed and listening reopens, exactly as the phone engine's
      // reply watchdog does. Aborting also discharges a late resolution.
      let timedOut = false;
      const deliver = (event) => {
        if (entry && !entry.committed) {
          if (speculative === entry) entry.pending.push(event);
          return;
        }
        dispatch(event);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        if (turnAbort === controller) {
          deliver({ type: 'replyFailed', message: 'The turn timed out.' });
        }
        controller.abort();
      }, turnTimeoutMs);
      turnTimer = timer;
      timer.unref?.();
      if (entry) {
        entry.timer = setTimeout(() => {
          // The worker normally emits final immediately after earlyEnd. If
          // that frame is lost, its already-finalized transcript still needs
          // to release the answer rather than strand the call in listening —
          // but only while nothing has been heard: the hold already gathering
          // that transcript must not count it a second time.
          if (speculative === entry && !ended && call.phase === 'listening' && !call.pendingText) {
            confirmed = { text: entry.text, untilMs: now() + speculationWindowMs };
            dispatch({ type: 'final', text: entry.text, turnId: session.voiceSessionId });
          }
        }, speculationWindowMs);
        entry.timer.unref?.();
        speculative = entry;
      }
      try {
        const result = await runTurn(session, text, {
          signal: controller.signal,
          attempt,
          onDelta: (delta) => deliver({ type: 'replyDelta', text: delta }),
          onApproval: (approval) =>
            deliver({ type: 'approvalRequired', summary: approval?.summary ?? 'Approval needed' }),
          // How far the runner got, so a silent turn is placed in the log: which
          // backend answered, was the turn sent, was it accepted, did any
          // activity arrive, and if it stalled, which step it was waiting on.
          // Elapsed is from this turn's own start, not from after resolution,
          // and the attempt id tells a replacement turn from the one it replaced.
          onStage: (detail) => log(
            `voice.turn stage session=${session.voiceSessionId} attempt=${attempt}`
            + ` stage=${detail?.stage} afterMs=${now() - turnStartedAt}`
            + `${detail?.backend ? ` backend=${detail.backend}` : ''}`
            + `${detail?.path ? ` path=${detail.path}` : ''}`
            + `${detail?.blockedOn ? ` blockedOn=${detail.blockedOn}` : ''}`
            + `${detail?.cause ? ` cause=${detail.cause}` : ''}`,
          ),
        });
        if (controller.signal.aborted) return;
        if (timedOut) return;
        if (result && result.hasContent === false) {
          deliver({ type: 'replyFailed', message: 'The turn produced no reply.' });
        } else {
          deliver({ type: 'replyDone' });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          deliver({ type: 'replyFailed', message: error.message });
        }
      } finally {
        // A changed final may have started a replacement while this aborted
        // speculative turn was unwinding. Clear only this turn's timer.
        clearTimeout(timer);
        if (turnTimer === timer) turnTimer = null;
        if (turnAbort === controller) turnAbort = null;
        if (entry && speculative === entry && controller.signal.aborted) {
          clearTimeout(entry.timer);
          speculative = null;
        }
      }
    };

    const onMessage = (data, isBinary) => {
      if (isBinary) {
        const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (frame.length > MAX_MEDIA_FRAME_BYTES) {
          ws?.close(1009, 'frame too large');
          return;
        }
        lastAudioAt = now();
        registry.markActivity(session.voiceSessionId);
        trace.audioFrames += 1;
        trace.audioBytes += frame.length;
        engine.pushAudio(frame);
        return;
      }
      try {
        // Any frame proves the phone is there, even one too malformed to act
        // on: the lease tracks liveness, not protocol correctness.
        registry.markActivity(session.voiceSessionId);
        const control = parsePhoneFrame(data.toString());
        if (control.t === 'mute') dispatch({ type: control.on ? 'mute' : 'unmute' });
        else if (control.t === 'skip' || control.t === 'bargein') {
          dispatch({ type: control.t });
        } else {
          dispatch({ type: 'end' });
        }
      } catch (error) {
        sendFrame({ t: 'error', code: 'bad_frame', message: error.message, fatal: false });
      }
    };

    function attach(newWs, { first = false } = {}) {
      if (ended) return;
      ws = newWs;
      clearResumeTimer();
      lastAudioAt = now();
      // Explicit, though `startAudioTimer` clears too: this is the path that
      // replaced a socket without the old one closing, so it is the one that
      // must not leave the previous call's timer running.
      clearAudioTimer();
      startAudioTimer();
      // The grant is real: a socket carrying this session actually arrived.
      registry.markAttached(session.voiceSessionId);

      newWs.on('message', onMessage);
      newWs.on('close', () => {
        if (ws === newWs) detach();
      });
      newWs.on('error', () => {
        if (ws === newWs) detach();
      });

      sendFrame({ t: 'ready', engine: session.engine });
      if (first) {
        dispatch({
          type: 'ready',
          turnId: session.voiceSessionId,
          utteranceHoldMs,
          continuationMs,
        });
      } else {
        sendFrame({ t: 'phase', phase: call.phase === 'opening' ? 'listening' : call.phase });
        flush();
      }
    }

    function detach() {
      if (ended) return;
      clearAudioTimer();
      ws = null;
      // Hold the call for a re-connect; if none comes, it ends as network.
      resumeTimer = setTimeout(() => end('network'), resumeTimeoutMs);
      resumeTimer.unref?.();
    }

    function end(reason) {
      // `endingNow` guards re-entry (end() dispatches the terminal event); the
      // `ended` flag only goes up once the terminal frames are on the wire, so
      // sendFrame's guard must not swallow the reducer's own `ended` frame.
      if (ended || endingNow) return;
      endingNow = true;
      // Detach before the registry is told again below: the call is already
      // leaving, so it must not re-enter through its own notification.
      leaveRegistry?.();
      clearResumeTimer();
      clearAudioTimer();
      clearTurnTimer();
      clearHoldTimer();
      if (speculative) {
        clearTimeout(speculative.timer);
        speculative = null;
      }
      dispatch({ type: 'socketClosed', reason });
      ended = true;
      endingNow = false;
      registry.end(session.voiceSessionId, reason);
      turnAbort?.abort();
      turnAbort = null;
      try {
        ws?.close(1000, reason);
      } catch {
        // the socket is already gone
      }
      ws = null;
      calls.delete(session.voiceSessionId);
      Promise.resolve(engine.close?.()).catch(() => undefined);
    }

    engine.on?.('final', (event) => {
      const text = String(event.text ?? '').trim();
      if (confirmed && text === confirmed.text && now() <= confirmed.untilMs) {
        // The transcript the socket already confirmed for this utterance, as an
        // echo of it: the words are in the turn, so sending them again would
        // answer the same sentence twice.
        confirmed = null;
        log(`voice.final duplicate session=${session.voiceSessionId} chars=${text.length}`);
        return;
      }
      confirmed = null;
      dispatch({ type: 'final', text: event.text, turnId: session.voiceSessionId });
    });
    engine.on?.('partial', (event) => dispatch({ type: 'partial', text: event.text }));
    engine.on?.('speechAudio', (event) => {
      // Outbound speech is traffic too: a call the phone is listening to has not
      // gone silent, so its reservation lease must not lapse mid-reply.
      registry.markActivity(session.voiceSessionId);
      dispatch({ type: 'speechAudio', pcm: event.pcm, gen: event.gen });
    });
    engine.on?.('speechDone', (event) => dispatch({ type: 'speechDone', gen: event.gen }));
    engine.on?.('earlyEnd', (event) => {
      if (call.phase !== 'listening' || turnAbort || speculative) return;
      void startTurn(event.text, { speculative: true });
    });
    engine.on?.('userSpeechStart', () => {
      if (speculative && !speculative.committed) {
        clearTimeout(speculative.timer);
        speculative.controller.abort();
        speculative = null;
      }
      dispatch({ type: 'userSpeechStart' });
    });
    engine.on?.('error', (event) =>
      dispatch({
        type: 'error',
        code: event.code ?? 'engine_error',
        message: event.message ?? 'error',
        fatal: Boolean(event.fatal),
      }),
    );

    // The engine must be opened before any audio can reach it: for the local
    // engine `open` spawns the worker and sends `voice.open`. A call created
    // without it pushed PCM into an engine that never loaded a model, so no
    // transcription ever came back and every call idled out (M6 regression).
    // A failed open used to be swallowed, so the phone saw a live call that
    // never transcribed.
    void Promise.resolve()
      .then(() => engine.open?.(session))
      .catch((error) => {
        const message = error?.message ?? 'The PC voice engine would not start.';
        log(`voice.stream engine-open fail session=${session.voiceSessionId} ${message}`);
        sendFrame({
          t: 'error',
          code: 'engine_open_failed',
          message,
          fatal: true,
        });
        end('engine');
      });

    api.attach(firstWs, { first: true });
    return api;
  }

  /** End every live call with one reason (a Gate restart, M7 task 7.2). */
  wss.endAll = (reason = 'gate-restart') => {
    for (const call of [...calls.values()]) call.end(reason);
  };

  return wss;
}
