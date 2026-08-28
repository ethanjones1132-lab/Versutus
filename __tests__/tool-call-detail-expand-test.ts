declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readToolCallCardSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'chat', 'tool-call-card.tsx'].join(SEP),
    'utf8',
  );
}

test('a failed tool call renders its detail expanded by default', () => {
  // On status 'error' the two-line-clipped detail is the ONLY failure
  // information the app has (tool-call-card.tsx:41-45), so the derived
  // expanded state falls back to the call's status: an errored card opens
  // with the full reason visible without a tap -- including one that
  // transitions running -> error mid-stream, since the fallback re-reads
  // the live prop instead of a mount-time snapshot.
  const src = readToolCallCardSource();
  expect(src).toMatch(
    /detailUserOverride !== null\s*\?\s*detailUserOverride\s*:\s*toolCall\.status === 'error'/,
  );
});

test('the card exposes a press target that flips the detail clamp', () => {
  const src = readToolCallCardSource();
  // The toggle follows the reasoning-toggle idiom (message-bubble.tsx:140-158):
  // a PressableScale carrying the kit CHIP_HIT_SLOP that flips local state
  // between the two-line clamp and the expanded detail.
  expect(src).toContain("from '@/lib/motion/chip-hit-slop'");
  expect(src).toMatch(/hitSlop=\{CHIP_HIT_SLOP\}/);
  expect(src).toMatch(/\{isDetailExpanded \? 'Hide detail' : 'Detail'\}/);
  expect(src).toMatch(
    /setDetailUserOverride\(\(prev\) => \(prev !== null \? !prev : status !== 'error'\)\)/,
  );
});

test('expanded renders the full detail in an inset surface with no line clamp', () => {
  const src = readToolCallCardSource();
  // The expanded branch carries no numberOfLines (the spec's "clears
  // numberOfLines"); the collapsed branch keeps the two-line clamp.
  const expanded = src.match(/isDetailExpanded \?\s*\(([\s\S]*?)\)\s*:\s*\(/);
  expect(expanded).not.toBeNull();
  expect(expanded![1]).toContain('styles.detailCard');
  expect(expanded![1]).toContain('{toolCall.detail}');
  expect(expanded![1]).not.toContain('numberOfLines');
  expect(src).toMatch(/numberOfLines=\{2\}/);
});