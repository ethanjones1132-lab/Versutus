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
});

describe('selectModel writes the announcement onto the fresh transcript', () => {
  test('a release replaces setMessages([]) with a system note naming both models', () => {
    const src = nodeFs
      .readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8')
      .replace(/\r\n/g, '\n');
    const select = src.match(/const selectModel = useCallback\([\s\S]*?\[activeGateway, closeModelPicker, sendChatInput, selectedBackendId, selectedBotId\],\n  \);/)?.[0];
    expect(select).toBeDefined();
    expect(select).toMatch(/appendSystemNote/);
    expect(select).toMatch(/modelSwitchAnnouncement/);
    expect(select).not.toMatch(/setMessages\(\[\]\)/);
  });

  test('appendSystemNote still produces a system-role line the transcript can show', () => {
    const next = appendSystemNote([], modelSwitchAnnouncement({ previous: 'a', next: 'b' }));
    expect(next).toHaveLength(1);
    expect(next[0].role).toBe('system');
    expect(next[0].text).toMatch(/new session/i);
  });
});
