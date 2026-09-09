declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readSection(): string {
  return readSource(['src', 'components', 'gateway', 'providers-section.tsx']);
}

// The card Check/Refresh/Disconnect/Disable/Delete/Enable taps used to be
// `void client.check(id).then(...)` with no catch, so a refused tap was an
// unhandled rejection and the section ErrorCard never named it. They now run
// through `runCardAction`, which mirrors saveKey: the refusal lands in
// setError and only a success touches state (map-snapshot replace for
// check/refresh, full load() for the rest).
describe('providers section card errors', () => {
  test('no bare client.check/refreshCatalog/disconnect/update/remove .then without a catch remains', () => {
    const src = readSection();
    expect(src).not.toContain('client.check(snapshot.id).then(');
    expect(src).not.toContain('client.refreshCatalog(snapshot.id).then(');
    expect(src).not.toContain('client.disconnect(snapshot.id).then(load)');
    expect(src).not.toContain('client.remove(snapshot.id).then(load)');
    expect(src).not.toContain("client.update(snapshot.id, { enabled: false }).then(load)");
    expect(src).not.toContain("client.update(snapshot.id, { enabled: true }).then(load)");
  });

  test('each card tap wires runCardAction with its action', () => {
    const src = readSection();
    expect(src).toContain("onCheck={() => void runCardAction(snapshot.id, 'check')}");
    expect(src).toContain("onRefresh={() => void runCardAction(snapshot.id, 'refresh')}");
    expect(src).toContain("onDisconnect={() => void runCardAction(snapshot.id, 'disconnect')}");
    expect(src).toContain("onDisable={() => void runCardAction(snapshot.id, 'disable')}");
    expect(src).toContain("onDelete={() => void runCardAction(snapshot.id, 'delete')}");
    expect(src).toContain("onEnable={() => void runCardAction(snapshot.id, 'enable')}");
  });

  test('runCardAction is defined exactly once', () => {
    const src = readSection();
    expect(src.match(/async function runCardAction\(/g)?.length ?? 0).toBe(1);
  });

  test('check/refresh keep the map-snapshot success path', () => {
    const src = readSection();
    expect(src).toContain('const next = await client.check(id);');
    expect(src).toContain('const next = await client.refreshCatalog(id);');
    expect(src).toContain('setProviders((current) => current.map((item) => (item.id === id ? next : item)));');
  });

  test('disconnect/disable/delete/enable reload only on success', () => {
    const src = readSection();
    expect(src).toContain('await client.disconnect(id);');
    expect(src).toContain('await client.update(id, { enabled: false });');
    expect(src).toContain('await client.update(id, { enabled: true });');
    expect(src).toContain('await client.remove(id);');
    expect(src).toContain('await load();');
  });

  test('runCardAction surfaces the refusal through setError like saveKey', () => {
    const src = readSection();
    expect(src).toContain('setError(caught instanceof Error ? caught.message : String(caught));');
    // The helper plus register/saveKey route into the same setter.
    expect((src.match(/setError\(caught instanceof Error \? caught\.message : String\(caught\)\);/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test('register/handleRename stay untouched; saveKey still sends the key', () => {
    const src = readSection();
    expect(src).toContain('await client.create(input);');
    expect(src).toContain('await client.setApiKey(id, value);');
    expect(src).toContain('await client.update(snapshotId, { label: trimmed });');
    expect(src).toContain('onRename={(nextLabel) => handleRename(snapshot.id, nextLabel)}');
  });
});
