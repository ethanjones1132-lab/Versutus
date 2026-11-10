import { reduceHandsfreeSession, type HandsfreeSessionState } from '@/lib/voice/handsfree-session';

declare const __dirname: string;


const SEP = __dirname.includes('\\') ? '\\' : '/';
const fs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

const provider = fs.readFileSync(
  [__dirname, '..', 'src', 'context', 'handsfree-voice-provider.tsx'].join(SEP),
  'utf8',
).replace(/\r\n/g, '\n');

function gateSubscription(): string {
  const start = provider.indexOf('const subscribeGate = useCallback(');
  const end = provider.indexOf('const teardown = useCallback(', start);
  return provider.slice(start, end);
}

describe('Gate-mode native terminal event wiring', () => {
  const subscription = gateSubscription();

  test.each([
    ['interruption', "dispatch({ type: 'interruption' })"],
    ['endRequested', "type: 'endRequested'"],
    ['fatalError', "type: 'fatalError', reason: event.reason"],
  ])('subscribes to %s and routes it through reducer teardown', (event, dispatch) => {
    expect(subscription).toContain(`addListener('${event}'`);
    expect(subscription).toContain(dispatch);
  });

  test('all terminal listeners are installed beside Gate and level listeners', () => {
    const listeners = [...subscription.matchAll(/addListener\('([^']+)'/g)].map((match) => match[1]);
    expect(listeners).toEqual(expect.arrayContaining([
      'gate', 'level', 'interruption', 'endRequested', 'fatalError',
    ]));
  });

  test.each([
    [{ type: 'interruption' } as const],
    [{ type: 'endRequested' } as const],
    [{ type: 'fatalError', reason: 'recognition-failed' } as const],
  ])('live Gate call terminal event %o reduces to provider teardown', (event) => {
    const liveCall: HandsfreeSessionState = {
      phase: 'listening', callsEnded: 0, partial: '', held: '', replyPlaying: false,
    };
    const result = reduceHandsfreeSession(liveCall, event);
    expect(result.state.phase).toBe('ending');
    expect(result.effects).toContainEqual({ kind: 'stop-session' });
  });
});
