declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function readBubbleSource(): string {
  return readSource(['src', 'components', 'chat', 'message-bubble.tsx']);
}

function readSheetSource(): string {
  return readSource(['src', 'components', 'chat', 'message-actions-sheet.tsx']);
}

// CHARTER priority 1 / visual-direction-2026-09: peers put no monospace clock
// under every message. The transcript row is text only; the time survives in
// the long-press overflow, where it belongs.
test('the transcript no longer prints a clock under every message', () => {
  const src = readBubbleSource();
  expect(src).not.toContain('formatClockTime');
  expect(src).not.toContain('styles.timestamp');
  expect(src).not.toMatch(/timestamp: \{/);
});

test('the clock still reaches the reader through the long-press sheet', () => {
  const sheet = readSheetSource();
  expect(sheet).toContain('formatClockTime(message.timestamp)');
  expect(sheet).toContain('timeLabel');
});

test('the overflow time rides the readable caption line, not an 11px mono whisper', () => {
  const sheet = readSheetSource();
  const meta = sheet.match(/<View style=\{styles\.meta\}>[\s\S]*?<\/View>/)?.[0];
  expect(meta).toBeDefined();
  expect(meta).toContain('variant="caption"');
  expect(meta).toContain('{timeLabel}');
});
