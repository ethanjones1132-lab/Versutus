import { EMPTY_BOT_SOUL, applyBotSoulRead, botSoulCopy, botSoulReadFromUnknown } from '@/lib/gateway/bots';

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

describe('bot detail soul loading', () => {
  test('the loading soul block holds layout with a Skeleton', () => {
    // A long-pressed sheet showed only the SOUL label while bots.get was in
    // flight (the soul copy is undefined until a read lands), then the soul
    // text popped in and pushed MODEL PIN down. The block now renders a
    // skeleton in that window, so the layout holds instead of jumping.
    const src = readSource('src', 'components', 'chat', 'bot-detail-sheet.tsx');
    expect(src).toContain('Skeleton');
    const loading = src.match(/!soulState\.loaded && !soulState\.failed \? \([\s\S]*?\) : null/)?.[0];
    expect(loading).toBeDefined();
    expect(loading).toMatch(/<Skeleton width="90%" height=\{44\}/);
  });

  test('the loading copy is undefined, so the blank was real', () => {
    // botSoulCopy returns undefined while !loaded && !failed — the only
    // thing the block rendered in that window was a label with no body,
    // hence the pop when the soul landed.
    expect(botSoulCopy({ soul: null, loaded: false, failed: false })).toBeUndefined();
  });

  test('the failed-first-read Retry is still single and on its own branch', () => {
    const src = readSource('src', 'components', 'chat', 'bot-detail-sheet.tsx');
    expect(src.match(/label="Retry"/g)).toHaveLength(1);
    expect(src).toContain('!soulState.loaded && soulState.failed && onRetry');
    expect(botSoulCopy({ soul: null, loaded: false, failed: true })).toBe(
      'The soul could not be read.',
    );
  });

  test('a failed first read never renders as "No standing instructions."', () => {
    // A junk envelope parses as a failed read, never an empty-ok soul, so
    // the sheet cannot claim the Bot has none when it knows nothing.
    const read = botSoulReadFromUnknown({ unexpected: 'envelope' });
    expect(read).toEqual({ ok: false });
    const state = applyBotSoulRead(EMPTY_BOT_SOUL, read);
    expect(botSoulCopy(state)).toBe('The soul could not be read.');
  });
});
