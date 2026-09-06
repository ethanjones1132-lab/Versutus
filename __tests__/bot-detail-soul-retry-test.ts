import { applyBotSoulRead, botSoulCopy, botSoulReadFromUnknown, EMPTY_BOT_SOUL } from '@/lib/gateway/bots';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('bot detail soul retry', () => {
  test('the failed first read offers a Retry action wired to the retry callback', () => {
    // A failed first read left the operator with static copy and no way
    // forward except closing and reopening the sheet. The sheet now renders
    // a retry button bound to the re-read callback the detail owner holds.
    const src = readSource('src', 'components', 'chat', 'bot-detail-sheet.tsx');
    expect(src).toContain('onRetry');
    const failed = src.match(
      /!soulState\.loaded && soulState\.failed && onRetry \? \([\s\S]*?\) : null/,
    )?.[0];
    expect(failed).toBeDefined();
    expect(failed).toMatch(/label="Retry"/);
    expect(failed).toMatch(/onPress=\{onRetry\}/);
  });

  test('the retry is offered only on the failed-first-read path, never over a soul', () => {
    // A failed re-read keeps the last good soul with its own stale copy —
    // the retry must not render there, and without a retry callback the
    // sheet renders no button at all.
    const src = readSource('src', 'components', 'chat', 'bot-detail-sheet.tsx');
    // Exactly one Retry affordance exists, and it lives on the failed-first
    // branch — no retry renders over a loaded soul or its stale copy.
    expect(src.match(/label="Retry"/g)).toHaveLength(1);
    expect(src).toContain('onRetry?: () => void;');
  });

  test('the failed-first-read copy still names the failure', () => {
    const src = readSource('src', 'components', 'chat', 'bot-detail-sheet.tsx');
    expect(src).toContain('botSoulCopy(soulState)');
    expect(botSoulCopy({ soul: null, loaded: false, failed: true })).toBe(
      'The soul could not be read.',
    );
  });

  test('a failed re-read keeps the last good soul with its stale copy', () => {
    // The lib keeps the two failures distinct: retrying over a loaded soul
    // must never clear it, so the Retry path cannot strand the operator
    // with less than they had.
    const loaded = { soul: 'Be curious.', loaded: true, failed: false };
    const next = applyBotSoulRead(loaded, { ok: false });
    expect(next).toEqual({ soul: loaded.soul, loaded: true, failed: true });
    expect(botSoulCopy(next)).toBe('Could not re-read the soul — showing the last one.');
  });

  test('a failed first read never renders as "No standing instructions."', () => {
    // A junk envelope parses as a failed read, never an empty-ok soul, so
    // the sheet cannot claim the Bot has none when it knows nothing.
    const read = botSoulReadFromUnknown({ unexpected: 'envelope' });
    expect(read).toEqual({ ok: false });
    const state = applyBotSoulRead(EMPTY_BOT_SOUL, read);
    expect(botSoulCopy(state)).toBe('The soul could not be read.');
  });

  test('chat-screen wires the retry to the same bots.get re-read', () => {
    const screen = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    expect(screen).toContain('handleSoulRetry');
    expect(screen).toContain('onRetry={handleSoulRetry}');
    // The retry re-runs the detail effect's read: same method, same parse,
    // same fold into the per-Bot soul state.
    expect(screen).toMatch(/gatewayRequest\('bots\.get', \{ id: target \}\)/);
    expect(screen).toMatch(/fold\(botSoulReadFromUnknown\(payload\)\)/);
  });
});
