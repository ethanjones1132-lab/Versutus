import {
  GATE_RECONNECT_WINDOW_MS,
  gateReconnectDelays,
  reconnectGateMedia,
} from '@/lib/voice/gate-reconnect';
import type { GateVoiceGrant } from '@/lib/voice/handsfree-start-reason';

const grant: GateVoiceGrant = {
  voiceSessionId: 'vs-1',
  streamPath: '/v1/voice/stream',
  engine: 'local',
};

const options = { url: 'ws://gate.local:8760/v1/voice/stream', token: 'tok', voiceSessionId: 'vs-1' };

function sleeper() {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
}

describe('gateReconnectDelays', () => {
  test('fits every backoff step inside the Gate resume window', () => {
    const delays = gateReconnectDelays();
    expect(delays.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(GATE_RECONNECT_WINDOW_MS);
    expect(delays.length).toBeGreaterThan(1);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1] / 2);
    }
  });
});

describe('reconnectGateMedia', () => {
  test('reopens the media socket with the same grant and stops there', async () => {
    const { sleeps, sleep } = sleeper();
    const attempts: unknown[] = [];
    const ok = await reconnectGateMedia({
      grant,
      gatewayUrl: 'http://gate.local:8760',
      gatewayToken: 'tok',
      startGateMedia: (opts) => {
        attempts.push(opts);
        return Promise.resolve(true);
      },
      isAborted: () => false,
      sleep,
      now: () => 0,
    });
    expect(ok).toBe(true);
    expect(attempts).toEqual([options]);
    // The first attempt waits one backoff step; a success asks for nothing more.
    expect(sleeps).toEqual([sleeps[0]]);
  });

  test('retries through refusal until the socket opens', async () => {
    const { sleeps, sleep } = sleeper();
    let calls = 0;
    const ok = await reconnectGateMedia({
      grant,
      gatewayUrl: 'http://gate.local:8760',
      gatewayToken: 'tok',
      startGateMedia: () => {
        calls += 1;
        return Promise.resolve(calls >= 3);
      },
      isAborted: () => false,
      sleep,
      now: () => 0,
    });
    expect(ok).toBe(true);
    expect(calls).toBe(3);
    expect(sleeps.length).toBe(3);
  });

  test('gives up when the call ended while reconnecting', async () => {
    const { sleep } = sleeper();
    let calls = 0;
    let aborted = false;
    const ok = await reconnectGateMedia({
      grant,
      gatewayUrl: 'http://gate.local:8760',
      gatewayToken: 'tok',
      startGateMedia: () => {
        calls += 1;
        return Promise.resolve(false);
      },
      isAborted: () => aborted,
      sleep: async (ms) => {
        await sleep(ms);
        aborted = true;
      },
      now: () => 0,
    });
    expect(ok).toBe(false);
    expect(calls).toBe(0);
  });

  test('gives up when the window runs out without a socket', async () => {
    const { sleep } = sleeper();
    let clock = 0;
    let calls = 0;
    const ok = await reconnectGateMedia({
      grant,
      gatewayUrl: 'http://gate.local:8760',
      gatewayToken: 'tok',
      startGateMedia: () => {
        calls += 1;
        clock += 30_000;
        return Promise.resolve(false);
      },
      isAborted: () => false,
      sleep: async (ms) => {
        await sleep(ms);
        clock += ms;
      },
      now: () => clock,
    });
    expect(ok).toBe(false);
    expect(calls).toBeGreaterThan(0);
  });

  test('a throwing startGateMedia is an attempt, not a rejection', async () => {
    const { sleep } = sleeper();
    let calls = 0;
    const ok = await reconnectGateMedia({
      grant,
      gatewayUrl: 'http://gate.local:8760',
      gatewayToken: 'tok',
      startGateMedia: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(true);
      },
      isAborted: () => false,
      sleep,
      now: () => 0,
    });
    expect(ok).toBe(true);
    expect(calls).toBe(2);
  });
});
