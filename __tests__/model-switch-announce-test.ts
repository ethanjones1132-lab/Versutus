import { appendSystemNote } from '@/lib/gateway/message-reducer';
import { modelSwitchAnnouncement, shouldReleaseSessionForModel } from '@/lib/gateway/model-selection';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

describe('modelSwitchAnnouncement', () => {
  test('names both models and says a new session was opened', () => {
    const text = modelSwitchAnnouncement({ previous: 'longcat-2.0', next: 'kimi-k3' });
    expect(text).toMatch(/longcat-2\.0/);
    expect(text).toMatch(/kimi-k3/);
    expect(text).toMatch(/new session/i);
  });

  test('releasing still happens — the announcement does not replace the release check', () => {
    expect(
      shouldReleaseSessionForModel({ previous: 'longcat-2.0', next: 'kimi-k3', hasSession: true }),
    ).toBe(true);
    expect(
      shouldReleaseSessionForModel({ previous: 'kimi-k3', next: 'kimi-k3', hasSession: true }),
    ).toBe(false);
  });

  // A thread with no stored override has no known previous model, yet the
  // release still happens (see shouldReleaseSessionForModel). Substituting
  // `next` for the missing previous printed "Was kimi-k3, now kimi-k3." on the
  // phone: a swap that never happened.
  test('no known previous model names only the new one, never "Was X, now X"', () => {
    expect(modelSwitchAnnouncement({ previous: undefined, next: 'opencode-go/mimo-v2.6-pro' }))
      .toBe('New session opened on opencode-go/mimo-v2.6-pro.');
    expect(modelSwitchAnnouncement({ previous: null, next: 'kimi-k3' }))
      .toBe('New session opened on kimi-k3.');
    expect(modelSwitchAnnouncement({ previous: '   ', next: 'kimi-k3' }))
      .toBe('New session opened on kimi-k3.');
  });

  test('a previous that is the same model by identity is not reported as a change', () => {
    expect(modelSwitchAnnouncement({ previous: 'kimi-k3', next: 'kimi-k3' }))
      .toBe('New session opened on kimi-k3.');
    // Qualification-insensitive, like every other model comparison here.
    expect(modelSwitchAnnouncement({ previous: 'moonshot/kimi-k3', next: 'kimi-k3' }))
      .toBe('New session opened on kimi-k3.');
  });

  test('a real change still names both models', () => {
    expect(modelSwitchAnnouncement({ previous: 'longcat-2.0', next: 'kimi-k3' }))
      .toBe('New session opened. Was longcat-2.0, now kimi-k3.');
  });
});

describe('selectModel writes the announcement onto the fresh transcript', () => {
  test('a release replaces setMessages([]) with a system note naming both models', () => {
    const src = nodeFs
      .readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8')
      .replace(/\r\n/g, '\n');
    // The block runs to the useCallback's own close, so its dependency list may
    // name whatever else the callback has come to read.
    const select = src.match(/const selectModel = useCallback\([\s\S]*?\n  \);/)?.[0];
    expect(select).toBeDefined();
    expect(select).toMatch(/appendSystemNote/);
    expect(select).toMatch(/modelSwitchAnnouncement/);
    expect(select).not.toMatch(/setMessages\(\[\]\)/);
  });

  // The caller used to pass `previousModel ?? modelId`, which turned a thread
  // with no known previous model into the "Was X, now X" line.
  test('the announcement is handed the previous model as it is, with no substitution', () => {
    const src = nodeFs
      .readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8')
      .replace(/\r\n/g, '\n');
    const select = src.match(/const selectModel = useCallback\([\s\S]*?\n  \);/)?.[0];
    expect(select).toBeDefined();
    expect(select).toMatch(/modelSwitchAnnouncement\(\{\s*previous:\s*previousModel\s*,\s*next:\s*modelId\s*\}\)/);
    expect(select).not.toMatch(/previousModel\s*\?\?/);
  });

  test('appendSystemNote still produces a system-role line the transcript can show', () => {
    const next = appendSystemNote([], modelSwitchAnnouncement({ previous: 'a', next: 'b' }));
    expect(next).toHaveLength(1);
    expect(next[0].role).toBe('system');
    expect(next[0].text).toMatch(/new session/i);
  });
});
