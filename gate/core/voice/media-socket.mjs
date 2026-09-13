// ─── The Gate media WebSocket: one socket and one engine per call ─────────
// `GET /v1/voice/stream?voiceSessionId=<id>` upgraded with the same device
// token the HTTP routes use. The session must belong to the calling device.
// Raw PCM16LE arrives as binary frames; the JSON control frames are the
// protocol module's phone frames. Nothing here writes audio to disk.

import { WebSocketServer } from 'ws';

import { parsePhoneFrame, serializeFrame } from './protocol.mjs';

export const VOICE_STREAM_PATH = '/v1/voice/stream';
export const MAX_MEDIA_FRAME_BYTES = 64 * 1024;
export const NO_AUDIO_TIMEOUT_MS = 30_000;

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

      const timer = setInterval(() => {
        if (now() - lastAudioAt > noAudioTimeoutMs) ws.close(1001, 'idle');
      }, Math.min(noAudioTimeoutMs, 1000));
      timer.unref?.();

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
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
          if (control.t === 'mute') engine.setMuted(control.on);
          else if (control.t === 'skip' || control.t === 'bargein') engine.cancelSpeech();
          else engine.emit('ended', { reason: 'user' });
        } catch (error) {
          ws.send(
            serializeFrame({ t: 'error', code: 'bad_frame', message: error.message, fatal: false }),
          );
        }
      });

      ws.on('close', cleanup);
      ws.on('error', cleanup);

      engine.on?.('final', (event) => {
        if (!closed) ws.send(serializeFrame({ t: 'final', turnId: session.voiceSessionId, text: event.text }));
      });
      engine.on?.('partial', (event) => {
        if (!closed) ws.send(serializeFrame({ t: 'partial', text: event.text }));
      });
      engine.on?.('speechAudio', (event) => {
        if (!closed) ws.send(event.pcm, { binary: true });
      });
      engine.on?.('speechDone', (event) => {
        if (!closed) ws.send(serializeFrame({ t: 'speech', gen: event.gen, state: 'end' }));
      });
      engine.on?.('error', (event) => {
        if (!closed) {
          ws.send(
            serializeFrame({
              t: 'error',
              code: event.code ?? 'engine_error',
              message: event.message ?? 'error',
              fatal: Boolean(event.fatal),
            }),
          );
        }
      });

      ws.send(serializeFrame({ t: 'ready', engine: session.engine }));
    });
  });

  return wss;
}
