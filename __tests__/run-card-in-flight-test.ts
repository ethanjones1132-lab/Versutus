// The live/finished verdict on a run card.
//
// `RunCard` decided "live" with its own copy of the status pair
// (`running` / `waiting-approval`). A row restored from disk whose fate this
// device never learned is in flight on Activity (`partitionRunsByState`), the
// glance, the drawer, Home and the widget — the card said it had settled, so
// the same run printed a finished header and lost its Stop while every other
// surface called it going. The card now reads `runIsInFlight`, the one shared
// answer. This is a source pin like run-card-duration-claim-test.ts: it reads
// the shipped file rather than rendering it.

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readRunCardSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'activity', 'run-card.tsx'].join(SEP),
    'utf8',
  );
}

describe('run card in-flight verdict', () => {
  test('the card reads the shared predicate, not its own copy of the status pair', () => {
    const src = readRunCardSource();

    expect(src).toMatch(/import \{ runIsInFlight \} from '@\/lib\/activity\/run-partition';/);
    expect(src).toMatch(/const live = runIsInFlight\(run\);/);
    // The private pair is gone from the card, so a restored row whose fate was
    // never learned stays live here exactly as it does everywhere else.
    expect(src).not.toContain("run.status === 'running' || run.status === 'waiting-approval'");
  });
});
