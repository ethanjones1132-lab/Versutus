import { openGateVoiceSession } from '@/lib/voice/handsfree-start-attempt';
import { HANDSFREE_START_TIMEOUT_MS, startDeadline } from '@/lib/voice/start-deadline';

// The Gate start used to spend TWO budgets. `startGateCall` minted one for the
// device identity read and `openGateVoiceSession` minted a second for the
// grant/prompt/media/release chain, so a Gate that black-holed both held the
// sheet on "Starting" for 90 seconds while every constant in the codebase said
// 45. The whole start is one budget now: the identity read and the chain behind
// it are links of the same clock, and a borrowed budget is the caller's to
// dispose.

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

/** A device identity read that takes `ms`, as a secure store behind a first unlock does. */
function identityAfter(ms: number): Promise<{ deviceId: string }> {
  return new Promise((resolve) => {
    setTimeout(() => resolve({ deviceId: 'phone-abc12345' }), ms);
  });
}

describe('the whole Gate start runs under one budget', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('40s of identity read leaves the chain 5s, and the timeout names the link', async () => {
    const budget = startDeadline();
    const startedAt = Date.now();

    // The device identity is read under the shared budget, and it is slow: 40 of
    // the 45 seconds are gone before the chain behind it even starts.
    const identity = budget.guard('the device identity', identityAfter(40_000));
    await jest.advanceTimersByTimeAsync(40_000);
    const device = await identity;
    expect(Date.now() - startedAt).toBe(40_000);

    const attempt = openGateVoiceSession({
      gatewayUrl: 'http://127.0.0.1:8760',
      gatewayToken: 'tok',
      target,
      device,
      // The same budget, not a fresh one. With a second budget this start would
      // still be waiting 45s from here — 85s in total.
      deadline: budget,
      // The grant never comes back.
      gatewayRequest: () => new Promise(() => {}),
      startGateMedia: async () => true,
      log: () => undefined,
    });

    await jest.advanceTimersByTimeAsync(5_000);
    const settled = await attempt;
    expect(settled.result).toBe('start-timed-out');
    // 45 seconds in total, not 85: one budget covers the identity read and
    // everything behind it.
    expect(Date.now() - startedAt).toBe(HANDSFREE_START_TIMEOUT_MS);
    // And it names the link that went quiet, which is the only way to tell a
    // wedged Gate from a wedged microphone prompt.
    expect(settled.detail).toBe('The call did not start: the PC never answered.');
    budget.dispose();
  });

  test('a chain that finished does not dispose the budget it borrowed', async () => {
    const budget = startDeadline();
    const attempt = await openGateVoiceSession({
      gatewayUrl: 'http://127.0.0.1:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      deadline: budget,
      gatewayRequest: async (method) => (method === 'voice.session.start' ? grant : { stopped: true }),
      startSession: async () => 'started',
      startGateMedia: async () => true,
      log: () => undefined,
    });
    expect(attempt.result).toBe('started');

    // The owner still holds a live budget: the chain did not quietly disarm it on
    // the way out, so a later link of the same start is bounded by it too. A
    // disarmed budget would never expire and this guard would never answer.
    const later = budget.guard('a later link', new Promise(() => {})).then(
      () => 'answered',
      (error: Error) => error.message,
    );
    await jest.advanceTimersByTimeAsync(HANDSFREE_START_TIMEOUT_MS);
    expect(await later).toBe('The call did not start: a later link never answered.');
    budget.dispose();
  });

  test('a caller that brings no budget still gets the chain its own', async () => {
    // The borrowed budget is optional: `startTimeoutMs` is the old path, and
    // every existing caller keeps working exactly as before.
    jest.useRealTimers();
    let hung = false;
    const hangGuard = setTimeout(() => {
      hung = true;
    }, 5_000);
    const settled = await openGateVoiceSession({
      gatewayUrl: 'http://127.0.0.1:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      gatewayRequest: () => new Promise(() => {}),
      startGateMedia: async () => true,
      startTimeoutMs: 20,
      log: () => undefined,
    });
    clearTimeout(hangGuard);
    expect(hung).toBe(false);
    expect(settled.result).toBe('start-timed-out');
  });
});
