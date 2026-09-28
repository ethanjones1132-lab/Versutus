import { openGateVoiceSession } from '@/lib/voice/handsfree-start-attempt';
import { mediaSocketUrl } from '@/lib/voice/gate-media-url';

const target = {
  label: 'Untitled',
  voiceEngine: 'local',
  surfaceKind: 'bot' as const,
  sessionId: 's1',
  botId: 'hermes',
};

const grant = {
  voiceSessionId: 'vs-1',
  streamPath: '/v1/voice/stream',
  engine: 'local',
};

describe('openGateVoiceSession against a fake Gate', () => {
  test('a ready local engine opens a call even when this phone has no recognizer', async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const media: { url: string; token: string; voiceSessionId: string }[] = [];
    const logs: string[] = [];

    const attempt = await openGateVoiceSession({
      gatewayUrl: 'http://127.0.0.1:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      gatewayRequest: async (method, params) => {
        calls.push({ method, params });
        if (method === 'voice.session.start') return grant;
        return { stopped: true };
      },
      startSession: async () => 'started',
      startGateMedia: async (options) => {
        media.push(options);
        return true;
      },
      startId: 'hs-attempt-1',
      log: (event) => logs.push(event.result),
    });

    expect(attempt.result).toBe('started');
    expect(attempt.grant).toEqual(grant);
    expect(calls[0]?.method).toBe('voice.session.start');
    expect(calls[0]?.params.engine).toBe('local');
    expect(calls[0]?.params.deviceId).toBe('phone-abc12345');
    // The media start carries its own attempt id: the native side keys the
    // socket to this start so a delayed old media call cannot replace a newer
    // retry's socket.
    expect(media[0]).toEqual({
      url: mediaSocketUrl('http://127.0.0.1:8760', '/v1/voice/stream'),
      token: 'tok',
      voiceSessionId: 'vs-1',
      startId: 'hs-attempt-1',
    });
    expect(logs).toEqual(['started']);
  });

  test('a no_engine refusal is named, not swallowed as unavailable', async () => {
    const error = Object.assign(new Error('The PC voice models are not installed.'), { code: 'no_engine' });
    const attempt = await openGateVoiceSession({
      gatewayUrl: 'http://127.0.0.1:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      gatewayRequest: async () => {
        throw error;
      },
      startGateMedia: async () => true,
      log: () => undefined,
    });
    expect(attempt.result).toBe('no-engine');
    expect(attempt.detail).toMatch(/not installed/);
  });

  test('an incomplete grant is named', async () => {
    const attempt = await openGateVoiceSession({
      gatewayUrl: 'http://127.0.0.1:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      gatewayRequest: async () => ({ voiceSessionId: 'vs-1' }),
      startGateMedia: async () => true,
      log: () => undefined,
    });
    expect(attempt.result).toBe('session-grant-incomplete');
  });

  test('a media failure stops the granted session AND cancels the native start by its id', async () => {
    const calls: string[] = [];
    const canceled: string[] = [];
    const attempt = await openGateVoiceSession({
      gatewayUrl: 'http://127.0.0.1:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      gatewayRequest: async (method) => {
        calls.push(method);
        if (method === 'voice.session.start') return grant;
        return { stopped: true };
      },
      startSession: async () => 'started',
      cancelStartSession: (startId) => {
        canceled.push(startId);
      },
      startGateMedia: async () => false,
      startId: 'hs-media-fail',
      log: () => undefined,
    });
    expect(attempt.result).toBe('media-start-failed');
    // The native session opened but could not be joined. It is cancelled by the
    // exact attempt id and the grant is released, so the next start is neither
    // a live microphone nor `call_in_progress`.
    expect(canceled).toEqual(['hs-media-fail']);
    expect(calls).toEqual(['voice.session.start', 'voice.session.stop']);
  });

  test('a media start that throws cancels the native start by its id, then releases the grant', async () => {
    const calls: string[] = [];
    const canceled: string[] = [];
    const attempt = await openGateVoiceSession({
      gatewayUrl: 'http://127.0.0.1:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      gatewayRequest: async (method) => {
        calls.push(method);
        if (method === 'voice.session.start') return grant;
        return { stopped: true };
      },
      startSession: async () => 'started',
      cancelStartSession: (startId) => {
        canceled.push(startId);
      },
      startGateMedia: async () => {
        throw new Error('socket refused');
      },
      startId: 'hs-media-throw',
      log: () => undefined,
    });
    expect(attempt.result).toBe('media-start-failed');
    expect(canceled).toEqual(['hs-media-throw']);
    expect(calls).toEqual(['voice.session.start', 'voice.session.stop']);
  });

  test('a denied microphone is named and the Gate session is released', async () => {
    const calls: string[] = [];
    const attempt = await openGateVoiceSession({
      gatewayUrl: 'http://127.0.0.1:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      gatewayRequest: async (method) => {
        calls.push(method);
        if (method === 'voice.session.start') return grant;
        return { stopped: true };
      },
      startSession: async () => 'permission-denied',
      startGateMedia: async () => true,
      log: () => undefined,
    });
    expect(attempt.result).toBe('permission-denied');
    expect(calls).toEqual(['voice.session.start', 'voice.session.stop']);
  });

  test('a thread with no session never reaches the media socket', async () => {
    const error = Object.assign(new Error('thread must name a session'), { code: 'invalid_request' });
    let media = 0;
    const attempt = await openGateVoiceSession({
      gatewayUrl: 'http://127.0.0.1:8760',
      gatewayToken: 'tok',
      target: { ...target, sessionId: '' },
      device: { deviceId: 'phone-abc12345' },
      gatewayRequest: async () => {
        throw error;
      },
      startGateMedia: async () => {
        media += 1;
        return true;
      },
      log: () => undefined,
    });
    expect(attempt.result).toBe('no-session');
    expect(media).toBe(0);
  });

  // The abandoned first attempt. The Gate grants the session, the media socket
  // is handed to the native module — and the native side never answers. The
  // start sequence has no deadline, so the provider's `await` never returned,
  // the call stayed in `starting` (so `canStart` was false and the user could
  // never press Call again), and the device's reservation stayed taken.
  test('a media link that never answers is abandoned, and the grant is released so a retry can start', async () => {
    const calls: string[] = [];
    const settled = await Promise.race([
      openGateVoiceSession({
        gatewayUrl: 'http://127.0.0.1:8760',
        gatewayToken: 'tok',
        target,
        device: { deviceId: 'phone-abc12345' },
        gatewayRequest: async (method) => {
          calls.push(method);
          if (method === 'voice.session.start') return grant;
          return { stopped: true };
        },
        startSession: async () => 'started',
        // The native media link hangs — no resolve, no reject.
        startGateMedia: () => new Promise(() => {}),
        startTimeoutMs: 20,
        log: () => undefined,
      }),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 300)),
    ]);

    expect(settled).not.toBe('hung');
    expect((settled as { result: string }).result).toBe('start-timed-out');
    expect(calls).toEqual(['voice.session.start', 'voice.session.stop']);
  });

  test('a grant that never comes back is abandoned rather than leaving the call starting', async () => {
    const settled = await Promise.race([
      openGateVoiceSession({
        gatewayUrl: 'http://127.0.0.1:8760',
        gatewayToken: 'tok',
        target,
        device: { deviceId: 'phone-abc12345' },
        gatewayRequest: () => new Promise(() => {}),
        startGateMedia: async () => true,
        startTimeoutMs: 20,
        log: () => undefined,
      }),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 300)),
    ]);

    expect(settled).not.toBe('hung');
    expect((settled as { result: string }).result).toBe('start-timed-out');
  });

  // The grant that lost the race. The budget expires while `voice.session.start`
  // is still in flight, so the start is abandoned — and then the Gate goes on to
  // issue the session it had already accepted. Nothing is awaiting that answer,
  // so without this the granted session stayed live on the PC and the very next
  // press of Call was refused as `call_in_progress`. A late grant is not a call
  // this phone opens: no native session, no media socket, only a stop of the
  // exact session it names.
  test('a grant that lands after the deadline is stopped by its own session, never by native start or media', async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    let nativeStarts = 0;
    let mediaStarts = 0;
    let releaseGrant!: (value: unknown) => void;
    const lateStart = new Promise<unknown>((resolve) => {
      releaseGrant = resolve;
    });

    const attempt = await openGateVoiceSession({
      gatewayUrl: 'http://127.0.0.1:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      gatewayRequest: (method, params) => {
        calls.push({ method, params });
        if (method === 'voice.session.start') return lateStart;
        return Promise.resolve({ stopped: true });
      },
      startSession: async () => {
        nativeStarts += 1;
        return 'started';
      },
      startGateMedia: async () => {
        mediaStarts += 1;
        return true;
      },
      startTimeoutMs: 20,
      log: () => undefined,
    });

    expect(attempt.result).toBe('start-timed-out');
    expect(nativeStarts).toBe(0);
    expect(mediaStarts).toBe(0);

    // The RPC answers long after the caller gave up on it.
    releaseGrant({ voiceSessionId: 'vs-late', streamPath: '/v1/voice/stream', engine: 'local' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls.map((call) => call.method)).toEqual(['voice.session.start', 'voice.session.stop']);
    expect(calls[1]?.params.voiceSessionId).toBe('vs-late');
    expect(nativeStarts).toBe(0);
    expect(mediaStarts).toBe(0);
  });

  test('a late grant is released by its own id, never by the session a newer retry opened', async () => {
    const stops: string[] = [];
    let releaseFirst!: (value: unknown) => void;
    const firstStart = new Promise<unknown>((resolve) => {
      releaseFirst = resolve;
    });

    const first = await openGateVoiceSession({
      gatewayUrl: 'http://127.0.0.1:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      gatewayRequest: (method, params) => {
        if (method === 'voice.session.start') return firstStart;
        stops.push(params.voiceSessionId as string);
        return Promise.resolve({ stopped: true });
      },
      startGateMedia: async () => true,
      startTimeoutMs: 20,
      log: () => undefined,
    });
    expect(first.result).toBe('start-timed-out');

    const secondGrant = { voiceSessionId: 'vs-new', streamPath: '/v1/voice/stream', engine: 'local' };
    const second = await openGateVoiceSession({
      gatewayUrl: 'http://127.0.0.1:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      gatewayRequest: async (method, params) => {
        if (method === 'voice.session.start') return secondGrant;
        stops.push(params.voiceSessionId as string);
        return { stopped: true };
      },
      startSession: async () => 'started',
      startGateMedia: async () => true,
      startTimeoutMs: 5_000,
      log: () => undefined,
    });
    expect(second.result).toBe('started');

    releaseFirst({ voiceSessionId: 'vs-old', streamPath: '/v1/voice/stream', engine: 'local' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stops).toEqual(['vs-old']);
  });

  test('a microphone prompt that never comes back is abandoned too', async () => {
    const settled = await Promise.race([
      openGateVoiceSession({
        gatewayUrl: 'http://127.0.0.1:8760',
        gatewayToken: 'tok',
        target,
        device: { deviceId: 'phone-abc12345' },
        gatewayRequest: async (method) => {
          if (method === 'voice.session.start') return grant;
          return { stopped: true };
        },
        startSession: () => new Promise(() => {}),
        startGateMedia: async () => true,
        startTimeoutMs: 20,
        log: () => undefined,
      }),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 300)),
    ]);

    expect(settled).not.toBe('hung');
    expect((settled as { result: string }).result).toBe('start-timed-out');
  });

  // An abandoned permission dialog still answers. Cancelling the exact native
  // attempt is what keeps that late answer from opening a microphone during
  // the retry the timeout invites. The cancel is issued before the start is
  // reported as timed out, and never runs for a media timeout — the mic was
  // already granted there.
  test('a microphone prompt that is abandoned cancels the native start', async () => {
    let canceled = 0;
    const attempt = await openGateVoiceSession({
      gatewayUrl: 'http://127.0.0.1:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      gatewayRequest: async (method) => (method === 'voice.session.start' ? grant : { stopped: true }),
      startSession: () => new Promise(() => {}),
      cancelStartSession: () => {
        canceled += 1;
      },
      startGateMedia: async () => true,
      startTimeoutMs: 20,
      log: () => undefined,
    });

    expect(attempt.result).toBe('start-timed-out');
    expect(attempt.detail).toMatch(/microphone prompt/);
    expect(canceled).toBe(1);
  });

  test('a media timeout cancels the native start it would otherwise leave live', async () => {
    let canceled = 0;
    const attempt = await openGateVoiceSession({
      gatewayUrl: 'http://127.0.0.1:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      gatewayRequest: async (method) => (method === 'voice.session.start' ? grant : { stopped: true }),
      startSession: async () => 'started',
      cancelStartSession: () => {
        canceled += 1;
      },
      startGateMedia: () => new Promise(() => {}),
      startTimeoutMs: 20,
      log: () => undefined,
    });

    expect(attempt.result).toBe('start-timed-out');
    expect(attempt.detail).toMatch(/audio link/);
    // The microphone opened before the media link went quiet. A timeout that
    // only released the grant left the native session live with no call.
    expect(canceled).toBe(1);
  });

  test('a prompt timeout cancels the exact native attempt it started, by id', async () => {
    const started: string[] = [];
    const canceled: string[] = [];
    const attempt = await openGateVoiceSession({
      gatewayUrl: 'http://127.0.0.1:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      gatewayRequest: async (method) => (method === 'voice.session.start' ? grant : { stopped: true }),
      startSession: (_title, startId) => {
        started.push(startId);
        return new Promise(() => {});
      },
      cancelStartSession: (startId) => {
        canceled.push(startId);
      },
      startGateMedia: async () => true,
      startTimeoutMs: 20,
      log: () => undefined,
    });

    expect(attempt.result).toBe('start-timed-out');
    expect(started).toHaveLength(1);
    // Cancellation names the attempt it belongs to, so the cleanup can never be
    // the unkeyed stop that reaches a newer retry's service.
    expect(canceled).toEqual(started);
  });

  // The late-cleanup counterexample: the old attempt's cancel runs after the
  // newer retry has already claimed the native side. Because cancellation is
  // keyed, it is a no-op there and the new retry survives.
  test('old cleanup completing late never cancels the newer retry', async () => {
    // A tiny model of the native ownership record: claim by id, and cancel only
    // the current owner.
    let owner = '';
    const cancelNative = (id: string) => {
      if (owner === id) owner = '';
    };
    let heldCancel: (() => void) | null = null;
    const cancelStartSession = (id: string) => {
      // The native call is queued; a newer start can land before it runs.
      heldCancel = () => cancelNative(id);
    };

    const common = {
      gatewayUrl: 'http://127.0.0.1:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      log: () => undefined,
    };

    const first = await openGateVoiceSession({
      ...common,
      gatewayRequest: async (method) => (method === 'voice.session.start' ? grant : { stopped: true }),
      startSession: (_title, startId) => {
        owner = startId;
        return new Promise(() => {});
      },
      cancelStartSession,
      startGateMedia: async () => true,
      startTimeoutMs: 20,
    });
    expect(first.result).toBe('start-timed-out');

    // The retry claims a newer id and owns the native side.
    let retryId = '';
    const second = await openGateVoiceSession({
      ...common,
      gatewayRequest: async (method) => (method === 'voice.session.start' ? grant : { stopped: true }),
      startSession: async (_title, startId) => {
        retryId = startId;
        owner = startId;
        return 'started';
      },
      cancelStartSession,
      startGateMedia: async () => true,
      startTimeoutMs: 5_000,
    });
    expect(second.result).toBe('started');
    expect(owner).toBe(retryId);

    // Now the old cleanup finally runs, after the new start. It belongs to the
    // old id, so the new retry's ownership is untouched.
    expect(heldCancel).not.toBeNull();
    heldCancel!();
    expect(owner).toBe(retryId);
  });

  // The media-failure counterexample: the native start succeeded, the media
  // link failed, and the exact-id cancel it issues is queued behind a newer
  // retry. The retry owns the native side by then, so the old cleanup is a
  // no-op there and the new call survives.
  test('an old media failure whose cancel lands late never cancels the newer retry', async () => {
    let owner = '';
    const cancelNative = (id: string) => {
      if (owner === id) owner = '';
    };
    let heldCancel: (() => void) | null = null;
    const cancelStartSession = (id: string) => {
      heldCancel = () => cancelNative(id);
    };
    const common = {
      gatewayUrl: 'http://127.0.0.1:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      log: () => undefined,
    };

    const first = await openGateVoiceSession({
      ...common,
      gatewayRequest: async (method) => (method === 'voice.session.start' ? grant : { stopped: true }),
      startSession: async (_title, startId) => {
        owner = startId;
        return 'started';
      },
      cancelStartSession,
      startGateMedia: async () => false,
      startTimeoutMs: 5_000,
    });
    expect(first.result).toBe('media-start-failed');

    // The retry claims a newer id and opens its media before the old cleanup
    // runs; the old cancel only names the old id.
    let retryId = '';
    const second = await openGateVoiceSession({
      ...common,
      gatewayRequest: async (method) => (method === 'voice.session.start' ? grant : { stopped: true }),
      startSession: async (_title, startId) => {
        retryId = startId;
        owner = startId;
        return 'started';
      },
      cancelStartSession,
      startGateMedia: async () => true,
      startTimeoutMs: 5_000,
    });
    expect(second.result).toBe('started');
    expect(owner).toBe(retryId);

    expect(heldCancel).not.toBeNull();
    heldCancel!();
    expect(owner).toBe(retryId);
  });

  // Counterexample to "the whole chain is bounded": the release fired when the
  // media link blew the budget is itself an await on the same Gate. A Gate that
  // never answers `voice.session.stop` — the wedged one the deadline exists for
  // — stranded the start exactly the way the original hang did: the promise
  // never settled, the phase never left `starting`, and the second press of
  // Call never came. The release is best-effort; the deadline still answers.
  test('a Gate that never answers the release does not strand the start', async () => {
    const calls: string[] = [];
    const settled = await Promise.race([
      openGateVoiceSession({
        gatewayUrl: 'http://127.0.0.1:8760',
        gatewayToken: 'tok',
        target,
        device: { deviceId: 'phone-abc12345' },
        gatewayRequest: (method) => {
          calls.push(method);
          if (method === 'voice.session.start') return Promise.resolve(grant);
          return new Promise(() => {});
        },
        startSession: async () => 'started',
        startGateMedia: () => new Promise(() => {}),
        startTimeoutMs: 20,
        log: () => undefined,
      }),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 300)),
    ]);

    expect(settled).not.toBe('hung');
    expect((settled as { result: string }).result).toBe('start-timed-out');
    expect(calls).toEqual(['voice.session.start', 'voice.session.stop']);
  });

  // Counterexample to the reason module's whole purpose: the deadline gave up
  // with one indistinguishable "the start", so neither the phone log nor the
  // sheet could tell a Gate that never answered from a microphone prompt that
  // never came back from an audio link that never opened. The class carries a
  // `step` for exactly this and nothing ever set it.
  test('the timeout names the link that went quiet', async () => {
    const common = {
      gatewayUrl: 'http://127.0.0.1:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      startTimeoutMs: 20,
      log: () => undefined,
    };

    const media = await openGateVoiceSession({
      ...common,
      gatewayRequest: async (method) => (method === 'voice.session.start' ? grant : { stopped: true }),
      startSession: async () => 'started',
      startGateMedia: () => new Promise(() => {}),
    });
    expect(media.result).toBe('start-timed-out');
    expect(media.detail).toMatch(/audio link/);

    const pc = await openGateVoiceSession({
      ...common,
      gatewayRequest: () => new Promise(() => {}),
      startGateMedia: async () => true,
    });
    expect(pc.result).toBe('start-timed-out');
    expect(pc.detail).toMatch(/the PC/);

    const mic = await openGateVoiceSession({
      ...common,
      gatewayRequest: async (method) => (method === 'voice.session.start' ? grant : { stopped: true }),
      startSession: () => new Promise(() => {}),
      startGateMedia: async () => true,
    });
    expect(mic.result).toBe('start-timed-out');
    expect(mic.detail).toMatch(/microphone prompt/);
  });

  test('a start that answers inside the budget is never treated as a timeout', async () => {
    const calls: string[] = [];
    const attempt = await openGateVoiceSession({
      gatewayUrl: 'http://127.0.0.1:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      gatewayRequest: async (method) => {
        calls.push(method);
        if (method === 'voice.session.start') return grant;
        return { stopped: true };
      },
      startSession: async () => 'started',
      startGateMedia: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return true;
      },
      startTimeoutMs: 5_000,
      log: () => undefined,
    });
    expect(attempt.result).toBe('started');
    expect(calls).toEqual(['voice.session.start']);
  });
});
