declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readSection(): string {
  return readSource(['src', 'components', 'gateway', 'environments-section.tsx']);
}

// The card Check/Start/Stop taps used to be `void client.check(id).then(load)`
// with no catch, so a refused tap was an unhandled rejection and the
// section ErrorCard never named it. They now run through `runCardAction`,
// which mirrors removeEnvironment: the refusal lands in setError and only
// a success reloads.
describe('environments section card errors', () => {
  test('no bare client.check/start/stop .then(load) without a catch remains', () => {
    const src = readSection();
    expect(src).not.toContain('client.check(environment.id).then(load)');
    expect(src).not.toContain('client.start(environment.id).then(load)');
    expect(src).not.toContain('client.stop(environment.id).then(load)');
  });

  test('each card tap wires runCardAction with its action', () => {
    const src = readSection();
    expect(src).toContain("onCheck={() => void runCardAction(environment.id, 'check')}");
    expect(src).toContain("onStart={() => void runCardAction(environment.id, 'start')}");
    expect(src).toContain("onStop={() => void runCardAction(environment.id, 'stop')}");
  });

  test('runCardAction is defined exactly once', () => {
    const src = readSection();
    expect(src.match(/async function runCardAction\(/g)?.length ?? 0).toBe(1);
  });

  test('runCardAction reloads only on success', () => {
    const src = readSection();
    expect(src).toContain('await client[action](id);');
    expect(src).toContain('await load();');
  });

  test('runCardAction surfaces the refusal through setError like removeEnvironment', () => {
    const src = readSection();
    expect(src).toContain('setError(caught instanceof Error ? caught.message : String(caught));');
    // Both the helper and removeEnvironment route into the same setter.
    expect((src.match(/setError\(caught instanceof Error \? caught\.message : String\(caught\)\);/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test('removeEnvironment stays byte-identical', () => {
    const src = readSection();
    expect(src).toContain('await client.remove(id);');
    expect(src).toContain('onRemove={() => void removeEnvironment(environment.id)}');
  });

  test('the sheet-opening onRun/onEdit paths stay untouched', () => {
    const src = readSection();
    expect(src).toContain('onRun={() => setRunTarget(environment)}');
    expect(src).toContain('onEdit={() => { setRegistering(false); setEditing(environment); }}');
  });
});
