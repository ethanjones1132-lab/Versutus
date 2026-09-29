import { teamPresence } from '@/lib/activity/presence';
import { providerDisplayName } from '@/lib/gateway/model-selection';
import type { ActivityRun } from '@/lib/gateway/runs';

declare const __dirname: string;

function source(...parts: string[]): string {
  const fs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
  const sep = __dirname.includes('\\') ? '\\' : '/';
  return fs.readFileSync([__dirname, '..', ...parts].join(sep), 'utf8').replace(/\r\n/g, '\n');
}

function run(id: string, botId: string | undefined, status: ActivityRun['status']): ActivityRun {
  return { id, botId, status, prompt: id, startedAt: 0, events: [] };
}

describe('the drawer says what each teammate is doing', () => {
  test('a waiting run means "needs you", and outranks a run in flight for the same Bot', () => {
    const presence = teamPresence([
      run('a', 'forge', 'running'),
      run('b', 'forge', 'waiting-approval'),
      run('c', 'ledger', 'running'),
      run('d', 'muse', 'complete'),
      run('e', undefined, 'running'),
    ]);
    expect(presence.get('forge')).toBe('needs-you');
    expect(presence.get('ledger')).toBe('working');
    expect(presence.has('muse')).toBe(false);
    expect(presence.size).toBe(2);
    // Order does not matter: working after waiting still reads "needs you".
    expect(teamPresence([run('b', 'forge', 'waiting-approval'), run('a', 'forge', 'running')]).get('forge')).toBe(
      'needs-you',
    );
  });

  test('the current destination is marked with the same light bar as a sheet row, and the count wears amber', () => {
    const drawer = source('src', 'components', 'nav', 'side-drawer-content.tsx');
    expect(drawer).toContain('backgroundColor: tokens.rowSelected');
    expect(drawer).toContain('styles.activeBar');
    expect(drawer).toContain('backgroundColor: tokens.statusConnecting');
  });
});

describe('the model sheet', () => {
  test('providers read as people write them', () => {
    expect(providerDisplayName('openai')).toBe('OpenAI');
    expect(providerDisplayName('anthropic')).toBe('Anthropic');
    expect(providerDisplayName('xai')).toBe('xAI');
    expect(providerDisplayName('DeepSeek')).toBe('DeepSeek'); // an owner's capitals are kept
    expect(providerDisplayName('  google ')).toBe('Google');
    expect(providerDisplayName('')).toBe('');
  });

  test('"Current" in the thread picker is the model the thread runs on, not the Gate default', () => {
    const screen = source('src', 'components', 'chat', 'chat-screen.tsx');
    expect(screen).toContain(
      "currentModel={modelPicker.mode === 'default' ? threadModel ?? activeGateway.model : activeGateway.model}",
    );
    expect(screen).toContain('const modelLabel = threadModel ?? \'Default model\';');
  });

  test('a collapsed provider still shows its true count', () => {
    const sheet = source('src', 'components', 'chat', 'thread-config-sheet.tsx');
    expect(sheet).toContain('count: section.data.length,');
    expect(sheet).toContain('{String(section.count)}');
    expect(sheet).not.toContain('String(section.data.length)');
  });

  test('available is the default and wears nothing; only current and locked are marked', () => {
    const sheet = source('src', 'components', 'chat', 'thread-config-sheet.tsx');
    expect(sheet).not.toContain("'Available'");
    expect(sheet).not.toContain('label="Current"');
    expect(sheet.match(/<CurrentBar \/>/g)).toHaveLength(2);
  });
});

describe('the segmented control', () => {
  test('its thumb travels the inner width, so the last segment stays inside the track', () => {
    const control = source('src', 'components', 'ui', 'SegmentedControl.tsx');
    expect(control).toContain('const innerWidth = Math.max(0, trackWidth - Spacing.half * 2);');
    expect(control).toContain('innerWidth / options.length');
  });
});

describe('the session sheet', () => {
  test('the one row that ends something reads as danger; its neighbours do not', () => {
    const sheet = source('src', 'components', 'chat', 'chat-overflow-sheet.tsx');
    expect(sheet.match(/tone="danger"/g)).toHaveLength(1);
    const at = sheet.indexOf('tone="danger"');
    expect(sheet.lastIndexOf('title=', at)).toBe(sheet.lastIndexOf('title="Disconnect gateway"', at));
  });
});
