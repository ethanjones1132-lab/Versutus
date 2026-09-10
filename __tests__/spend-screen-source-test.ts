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

const spendScreen = () => readSource('src', 'app', 'gateway', 'spend.tsx');
const layout = () => readSource('src', 'app', '_layout.tsx');
const chatScreen = () => readSource('src', 'components', 'chat', 'chat-screen.tsx');

/** The `<Stack.Screen name="...">` element, from its name to its closing `/>`. */
function stackScreen(src: string, name: string): string {
  const at = src.indexOf(`name="${name}"`);
  if (at === -1) return '';
  const end = src.indexOf('/>', at);
  return end === -1 ? src.slice(at) : src.slice(at, end);
}

/** The option keys one Stack.Screen carries, so two treatments can be compared. */
function optionKeys(block: string): string[] {
  return [...block.matchAll(/([A-Za-z][A-Za-z0-9_]*):/g)]
    .map((match) => match[1])
    .sort();
}

// P5's screen. The read and every fold it needs already shipped (iters 026 and
// 028) with nothing painting them. This pins the route, its single read, and
// the two discipline rules P5 inherits: a failed read is named, never rendered
// as zero spend, and no second aggregation is recomputed on the screen.
describe('the Spend route makes exactly the read the shipped folds need', () => {
  test('the route screen reads the session catalogue at the shared cap', () => {
    const src = spendScreen();
    expect(src).toContain("gatewayRequest('sessions.list', { limit: SESSION_SPEND_LIST_LIMIT })");
    // One transport, one read: no duplicate catalogue fetch on this screen.
    expect(src).not.toContain('gatewayFetch(');
  });

  test('the cap, the parser and the fold are imported, not re-spelled here', () => {
    const src = spendScreen();
    expect(src).toContain("from '@/lib/gateway/session-analytics'");
    expect(src).toContain('SESSION_SPEND_LIST_LIMIT');
    expect(src).toContain('sessionSpendReadFromUnknown(');
    expect(src).toContain('applySessionSpendRead(');
    expect(src).toContain('totalUsage(');
  });

  test('the window line and the basis header are the shipped copy', () => {
    const src = spendScreen();
    expect(src).toContain('spendWindowCopy(state.sessions.length)');
    expect(src).toContain('spendCostBasis(state.sessions)');
    expect(src).toContain('spendBasisCopy(basis)');
    expect(src).toContain('{sessionSpendCopy(spend)}');
  });
});

describe('the Stack registers the Spend route as a modal, like gateway/settings', () => {
  test('gateway/spend is registered with its own title', () => {
    const block = stackScreen(layout(), 'gateway/spend');
    expect(block).not.toBe('');
    expect(block).toContain("title: 'Spend'");
  });

  test('its modal treatment matches gateway/settings exactly', () => {
    const spend = stackScreen(layout(), 'gateway/spend');
    const settings = stackScreen(layout(), 'gateway/settings');
    expect(settings).not.toBe('');
    expect(optionKeys(spend)).toEqual(optionKeys(settings));
  });
});

describe('the screen never renders an unread catalogue as zero spend', () => {
  test('a failed first read is the named sentence, not a total', () => {
    const src = spendScreen();
    expect(src).toContain("from '@/lib/gateway/spend-report'");
    expect(src).toContain('{SPEND_UNREAD_COPY}');
  });

  test('the total and its header render only off a loaded read', () => {
    const src = spendScreen();
    const gate = src.indexOf('state.loaded ? (');
    const total = src.indexOf('{sessionSpendCopy(spend)}');
    const unread = src.indexOf('{SPEND_UNREAD_COPY}');
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(total).toBeGreaterThan(gate);
    expect(unread).toBeGreaterThan(total);
  });
});

describe('what must keep working', () => {
  test("ChatScreen's own spend glance keeps its read", () => {
    expect(chatScreen()).toContain(
      "gatewayRequest('sessions.list', { limit: SESSION_SPEND_LIST_LIMIT })",
    );
  });
});
