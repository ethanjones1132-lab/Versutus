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

import { WebSocketServer } from 'ws';

import { parsePhoneFrame, serializeFrame } from './protocol.mjs';
import { INITIAL_VOICE_SESSION, reduceVoiceSession } from './voice-session.mjs';

export const VOICE_STREAM_PATH = '/v1/voice/stream';
export const MAX_MEDIA_FRAME_BYTES = 64 * 1024;
export const NO_AUDIO_TIMEOUT_MS = 30_000;
// How long a turn started on an early end survives before it is committed.
export const SPECULATION_WINDOW_MS = 600;

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
  registry,
  createEngine,
  runTurn,
  now = () => Date.now(),
  noAudioTimeoutMs = NO_AUDIO_TIMEOUT_MS,
} = {}) {
  const wss = new WebSocketServer({ noServer: true });

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
    if (!grant) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    const voiceSessionId = url.searchParams.get('voiceSessionId');
    const session = voiceSessionId ? registry.get(voiceSessionId) : null;
    if (!session) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (session.deviceId !== grant.deviceId) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    if (session.ended) {
      rejectUpgrade(socket, 409, 'Conflict');
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      session.socket = ws;
      const engine = createEngine(session, ws);
      let closed = false;
      let lastAudioAt = now();
      let call = INITIAL_VOICE_SESSION;
      let turnAbort = null;
      // A turn started on `earlyEnd` before the worker's `final` arrives. It is
      // discarded if speech resumes inside the window, and promoted by `final`.
      let speculative = null;

      const sendFrame = (frame) => {
        if (!closed) ws.send(serializeFrame(frame));
      };

      const runEffect = (effect) => {
        switch (effect.kind) {
          case 'send':
            sendFrame(effect.frame);
            break;
          case 'sendAudio':
            if (!closed) ws.send(effect.pcm, { binary: true });
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
          default:
            // `audit` (M9) and anything newer are inert here.
            break;
        }
      };

      const dispatch = (event) => {
        const out = reduceVoiceSession(call, event);
        call = out.state;
        for (const effect of out.effects) runEffect(effect);
      };

      const startTurn = async (text, { speculative: isSpeculative = false } = {}) => {
        if (typeof runTurn !== 'function') {
          dispatch({ type: 'replyFailed', message: 'No backend is available for this call.' });
          return;
        }
        const controller = new AbortController();
        turnAbort = controller;
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
          if (turnAbort === controller) turnAbort = null;
          if (speculative?.controller === controller) {
            clearTimeout(speculative.timer);
            speculative = null;
          }
        }
      };

      const timer = setInterval(() => {
        if (now() - lastAudioAt > noAudioTimeoutMs) ws.close(1001, 'idle');
      }, Math.min(noAudioTimeoutMs, 1000));
      timer.unref?.();

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        if (speculative) {
          clearTimeout(speculative.timer);
          speculative = null;
        }
        turnAbort?.abort();
        turnAbort = null;
        dispatch({ type: 'socketClosed' });
        if (session.socket === ws) session.socket = null;
        Promise.resolve(engine.close?.()).catch(() => undefined);
      };

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
          if (frame.length > MAX_MEDIA_FRAME_BYTES) {
            ws.close(1009, 'frame too large');
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
      });

      ws.on('close', cleanup);
      ws.on('error', cleanup);

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

      sendFrame({ t: 'ready', engine: session.engine });
      dispatch({ type: 'ready', turnId: session.voiceSessionId });
    });
  });

  return wss;
}
