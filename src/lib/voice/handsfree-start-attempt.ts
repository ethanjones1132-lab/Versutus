// ─── Opening a Gate-powered call, without the React provider ──────────────
// The provider used to swallow every `voice.session.start` failure into
// `'unavailable'`. This is the same sequence the provider runs, injectable so
// a test can drive it against a fake Gate and assert that a call opens.

import { mediaSocketUrl } from '@/lib/voice/gate-media-url';
import {
  logHandsfreeStart,
  mapGateSessionStartFailure,
  parseVoiceSessionGrant,
  type GateVoiceGrant,
  type HandsfreeStartAttempt,
  type HandsfreeStartLog,
} from '@/lib/voice/handsfree-start-reason';

export type OpenGateVoiceSessionInput = {
  gatewayUrl: string;
  gatewayToken: string;
  target: {
    label: string;
    voiceEngine?: string;
    surfaceKind: 'configurable' | 'bot';
    sessionId: string;
    botId?: string;
  };
  device: { deviceId: string };
  gatewayRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  startSession?: (title: string) => Promise<'started' | 'permission-denied' | 'unavailable'>;
  startGateMedia: (options: {
    url: string;
    token: string;
    voiceSessionId: string;
  }) => Promise<boolean>;
  mediaUrl?: (base: string, path: string) => string;
  log?: (event: HandsfreeStartLog) => void;
  now?: () => string;
};

async function stopGrantedSession(
  gatewayRequest: OpenGateVoiceSessionInput['gatewayRequest'],
  voiceSessionId: string | undefined,
): Promise<void> {
  if (!voiceSessionId) return;
  try {
    await gatewayRequest('voice.session.stop', { voiceSessionId, reason: 'start-failed' });
  } catch {
    // the session's own idle close ends it if this never lands
  }
}

function finish(
  attempt: HandsfreeStartAttempt,
  log: (event: HandsfreeStartLog) => void,
  extra: { engine?: string } = {},
): HandsfreeStartAttempt {
  log({
    result: attempt.result,
    transport: 'gate',
    engine: extra.engine,
    detail: attempt.detail,
  });
  return attempt;
}

/**
 * Grant a Gate voice session, take the microphone, and open the media socket.
 * A grant that cannot be joined is stopped so the next start is not
 * `call_in_progress`.
 */
export async function openGateVoiceSession(
  input: OpenGateVoiceSessionInput,
): Promise<HandsfreeStartAttempt & { grant?: GateVoiceGrant }> {
  const log = input.log ?? logHandsfreeStart;
  const toMediaUrl = input.mediaUrl ?? mediaSocketUrl;

  let raw: unknown;
  try {
    raw = await input.gatewayRequest('voice.session.start', {
      engine: input.target.voiceEngine ?? 'auto',
      thread: {
        kind: input.target.surfaceKind,
        sessionId: input.target.sessionId,
        botId: input.target.botId,
      },
      disclosureAcceptedAt: (input.now ?? (() => new Date().toISOString()))(),
      ...input.device,
    });
  } catch (error) {
    const mapped = mapGateSessionStartFailure(error);
    return finish({ result: mapped.result, detail: mapped.detail }, log);
  }

  const grant = parseVoiceSessionGrant(raw);
  if (!grant) {
    return finish({ result: 'session-grant-incomplete' }, log);
  }

  if (input.startSession) {
    let sessionOutcome: 'started' | 'permission-denied' | 'unavailable';
    try {
      sessionOutcome = await input.startSession(input.target.label);
    } catch {
      sessionOutcome = 'unavailable';
    }
    if (sessionOutcome !== 'started') {
      await stopGrantedSession(input.gatewayRequest, grant.voiceSessionId);
      return finish(
        {
          result: sessionOutcome === 'permission-denied'
            ? 'permission-denied'
            : 'native-session-unavailable',
        },
        log,
        { engine: grant.engine },
      );
    }
  }

  let started = false;
  try {
    started = await input.startGateMedia({
      url: toMediaUrl(input.gatewayUrl, grant.streamPath),
      token: input.gatewayToken,
      voiceSessionId: grant.voiceSessionId,
    });
  } catch {
    started = false;
  }
  if (!started) {
    await stopGrantedSession(input.gatewayRequest, grant.voiceSessionId);
    return finish(
      { result: 'media-start-failed' },
      log,
      { engine: grant.engine },
    );
  }

  log({ result: 'started', transport: 'gate', engine: grant.engine });
  return { result: 'started', grant };
}
