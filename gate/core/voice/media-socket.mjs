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
// How long one Bot turn may run before the call names it failed and reopens,
// symmetric with the phone engine's reply watchdog: a backend that never
// answers must not park the call in thinking forever.
export const TURN_TIMEOUT_MS = 120_000;

function rejectUpgrade(socket, status, message) {
  try {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  } catch {
    // the peer is already gone
  }
  socket.destroy();
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
    let turnAbort = null;
    let turnTimer = null;
    let speculative = null;
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

    const clearTurnTimer = () => {
      if (turnTimer) {
        clearTimeout(turnTimer);
        turnTimer = null;
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
        case 'turn.run':
          if (speculative) {
            clearTimeout(speculative.timer);
            if (speculative.text === effect.text) {
              // `final` promotes the turn the early end already started.
              speculative.committed = true;
              break;
            }
            speculative.controller.abort();
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
        case 'audit':
          // The reducer names the end; the line carries counts and names only.
          audit?.({
            deviceId: session.deviceId,
            botId: session.thread?.botId ?? null,
            engine: session.engine,
            fellBackFrom: session.fellBackFrom ?? null,
            turns,
            secondsListening: Math.round(listeningMs / 1000),
            secondsSpeaking: Math.round(speakingMs / 1000),
            error: effect.reason ?? null,
          });
          break;
        default:
          // Anything newer is inert here.
          break;
      }
    };

    const dispatch = (event) => {
      const out = reduceVoiceSession(call, event);
      const at = now();
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
      const controller = new AbortController();
      turnAbort = controller;
      // A backend that never answers must not park the call in thinking: the
      // turn is failed and listening reopens, exactly as the phone engine's
      // reply watchdog does. Aborting also discharges a late resolution.
      let timedOut = false;
      turnTimer = setTimeout(() => {
        timedOut = true;
        if (turnAbort === controller) {
          dispatch({ type: 'replyFailed', message: 'The turn timed out.' });
        }
        controller.abort();
      }, turnTimeoutMs);
      turnTimer.unref?.();
      if (isSpeculative) {
        const entry = { text, controller, committed: false, timer: null };
        entry.timer = setTimeout(() => {
          entry.committed = true;
        }, SPECULATION_WINDOW_MS);
        entry.timer.unref?.();
        speculative = entry;
      }
      try {
        const result = await runTurn(session, text, {
          signal: controller.signal,
          onDelta: (delta) => dispatch({ type: 'replyDelta', text: delta }),
          onApproval: (approval) =>
            dispatch({ type: 'approvalRequired', summary: approval?.summary ?? 'Approval needed' }),
        });
        if (controller.signal.aborted) return;
        if (timedOut) return;
        if (result && result.hasContent === false) {
          dispatch({ type: 'replyFailed', message: 'The turn produced no reply.' });
        } else {
          dispatch({ type: 'replyDone' });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          dispatch({ type: 'replyFailed', message: error.message });
        }
      } finally {
        clearTurnTimer();
        if (turnAbort === controller) turnAbort = null;
        if (speculative?.controller === controller) {
          clearTimeout(speculative.timer);
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
        engine.pushAudio(frame);
        return;
      }
      try {
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
        dispatch({ type: 'ready', turnId: session.voiceSessionId });
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
      clearResumeTimer();
      clearAudioTimer();
      clearTurnTimer();
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

    engine.on?.('final', (event) =>
      dispatch({ type: 'final', text: event.text, turnId: session.voiceSessionId }),
    );
    engine.on?.('partial', (event) => dispatch({ type: 'partial', text: event.text }));
    engine.on?.('speechAudio', (event) =>
      dispatch({ type: 'speechAudio', pcm: event.pcm, gen: event.gen }),
    );
    engine.on?.('speechDone', (event) => dispatch({ type: 'speechDone', gen: event.gen }));
    engine.on?.('earlyEnd', (event) => {
      if (call.phase !== 'listening' || turnAbort) return;
      void startTurn(event.text, { speculative: true });
    });
    engine.on?.('userSpeechStart', () => {
      if (speculative && !speculative.committed) {
        clearTimeout(speculative.timer);
        speculative.controller.abort();
        speculative = null;
      }
      dispatch({ type: 'bargein' });
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
