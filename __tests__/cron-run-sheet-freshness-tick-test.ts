declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readCronRunSheetSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'activity', 'cron-run-sheet.tsx'].join(SEP),
    'utf8',
  );
}

describe('cron run sheet freshness tick scope', () => {
  test('the per-second clock no longer lives in CronRunSheet', () => {
    // forceTick + its setInterval re-rendered the whole sheet -- turns.map and
    // the readiness line -- once a second purely to bump the "updated Ns ago"
    // stamp. The clock must be gone from the parent.
    const src = readCronRunSheetSource();
    expect(src).not.toMatch(/forceTick/);
    expect(src).not.toMatch(/setInterval\(\(\) => forceTick/);
  });

  test('the freshness stamp is rendered by a dedicated FreshnessLabel child that owns the tick', () => {
    // Mirrors the LiveElapsed extraction from run-card.tsx: the parent stays
    // still between polls; only the label re-renders for the clock.
    const src = readCronRunSheetSource();
    expect(src).toMatch(/function FreshnessLabel/);
    const uses = [...src.matchAll(/useNow\(/g)];
    expect(uses).toHaveLength(1);
    // useNow must appear inside FreshnessLabel, not at the CronRunSheet top level.
    expect(src.slice(0, uses[0].index)).toMatch(/function FreshnessLabel/);
  });

  test('the parent hands polledAt to FreshnessLabel rather than ticking itself', () => {
    const src = readCronRunSheetSource();
    expect(src).toMatch(/<FreshnessLabel polledAt=\{polledAt\} ?\/>/);
    // The parent no longer feeds its own clock into freshnessLabel; the child
    // does, so the turn list is untouched between polls.
    expect(src).not.toMatch(/freshnessLabel\(polledAt\)\s*\}/);
  });
});
