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

// Sheet content stubs kept out of the repo's own files for the pin check —
// the guard reads the repo, so a token literal here would be a false
// positive in no test but ours; spelled indirectly.
const CREDENTIAL_WORDS = ['listen key', 'api_server_key', 'bearer'];

// D2 build 3: a long-pressed Bot star explains itself — the full name, what
// it is running, its routine health and its approvals — without leaving the
// map. The tap behaviour is untouched; the sheet is a second affordance.
describe('the Bot star detail sheet view-model', () => {
  const { botSheetView } = require('../src/lib/fleet/bot-sheet') as {
    botSheetView(input: {
      node: {
        label: string;
        botId?: string;
        runningRunName?: string;
        badges: { label: string; tone: string }[];
      };
      bot?: { displayName: string; description?: string | null; routable: boolean } | null;
    }): {
      name: string;
      id: string | null;
      description: string | null;
      running: string | null;
      routine: string | null;
      approvals: string | null;
    };
  };

  test('the full name comes off the roster, not the clipped label', () => {
    const view = botSheetView({
      node: {
        label: 'versutus-dev'.slice(0, 6), // what ~50px truncates to
        botId: 'versutus-dev',
        badges: [],
      },
      bot: { displayName: 'versutus-dev', routable: true },
    });
    expect(view.name).toBe('versutus-dev');
    expect(view.id).toBe('versutus-dev');
  });

  test('a Bot with no roster row still names itself with the map label', () => {
    const view = botSheetView({ node: { label: 'ledger', botId: 'ledger', badges: [] } });
    expect(view.name).toBe('ledger');
    expect(view.id).toBe('ledger');
    expect(view.description).toBeNull();
  });

  test('the roster description travels to the sheet', () => {
    const view = botSheetView({
      node: { label: 'ledger', botId: 'ledger', badges: [] },
      bot: { displayName: 'ledger', description: 'Fleet bookkeeping', routable: true },
    });
    expect(view.description).toBe('Fleet bookkeeping');
  });

  test('a live run is named; no run reads as no run, not as silence error', () => {
    const running = botSheetView({
      node: { label: 'a', botId: 'a', runningRunName: 'nightly sweep', badges: [] },
    });
    expect(running.running).toContain('nightly sweep');
    const idle = botSheetView({ node: { label: 'a', botId: 'a', badges: [] } });
    expect(idle.running).toBeNull();
  });

  test('routine health is the map badge, or an honest no-facts line', () => {
    const failing = botSheetView({
      node: {
        label: 'a',
        botId: 'a',
        badges: [{ label: 'routine failing', tone: 'danger' }],
      },
    });
    expect(failing.routine).toBe('routine failing');
    const quiet = botSheetView({ node: { label: 'a', botId: 'a', badges: [] } });
    expect(quiet.routine).toBeNull();
  });

  test('pending approvals are counted, not invented', () => {
    const waiting = botSheetView({
      node: {
        label: 'a',
        botId: 'a',
        badges: [{ label: '2 approvals', tone: 'danger' }],
      },
    });
    expect(waiting.approvals).toBe('2 approvals');
    const none = botSheetView({ node: { label: 'a', botId: 'a', badges: [] } });
    expect(none.approvals).toBeNull();
  });

  test('the sheet names no credential', () => {
    const view = botSheetView({
      node: {
        label: 'a',
        botId: 'a',
        badges: [{ label: '1 approval', tone: 'danger' }],
      },
      bot: { displayName: 'a', routable: false },
    });
    const text = Object.values(view).join(' ').toLowerCase();
    for (const word of CREDENTIAL_WORDS) expect(text).not.toContain(word);
  });
});

describe('the route wires the sheet, and the tap is untouched', () => {
  const fleetRoute = () => readSource('src', 'app', 'fleet.tsx');
  const view = () => readSource('src', 'components', 'fleet', 'constellation-view.tsx');
  const sheetComponent = () => readSource('src', 'components', 'fleet', 'bot-sheet.tsx');

  test('the constellation view forwards a long-press beside the taps', () => {
    const src = view();
    expect(src).toContain('onLongPressNode');
    expect(src).toContain('onLongPressNode?.(node)');
    // The plain tap prop survives unchanged.
    expect(src).toContain('onPress={() => onPressNode?.(node)}');
  });

  test('the route computes the sheet from the pure view-model and opens it on long-press', () => {
    const src = fleetRoute();
    expect(src).toContain('botSheetView(');
    expect(src).toContain('onLongPressNode={');
    expect(src).toContain('import { FleetBotSheet }');
  });

  test('a plain tap still opens Bot Chat through the same pure decision', () => {
    const src = fleetRoute();
    expect(src).toContain('botTap(');
    expect(src).toContain('onPressNode={handlePressNode}');
    expect(src).toContain('void openBot(botId)');
  });

  test('the sheet renders BaseSheet and a chat row gated on the routing verdict', () => {
    const src = sheetComponent();
    expect(src).toContain('<BaseSheet');
    expect(src).toContain('Open Chat');
    // The chat row is the route's own gate, not an unconditional affordance.
    expect(src).toContain('onOpenChat ?');
  });

  test('the sheet names no credential', () => {
    const src = sheetComponent();
    const text = src.toLowerCase();
    for (const word of CREDENTIAL_WORDS) expect(text).not.toContain(word);
  });
});
