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

function readSheet(): string {
  return readSource(['src', 'components', 'gateway', 'provider-key-sheet.tsx']);
}

function readSaveKey(): string {
  const src = readSection();
  const start = src.indexOf('async function saveKey');
  const end = src.indexOf('const canRegister', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

function readSavePress(): string {
  const src = readSheet();
  const start = src.indexOf('onPress={() => {');
  const end = src.indexOf('/>', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

// saveKey used to setEditingId(null) in finally, and the sheet cleared the
// paste in onPress before the Gate answered — so a refused setApiKey named
// its reason in the section ErrorCard while the sheet was gone and the key
// was lost. Close and clear only after a successful save; keep the typed
// value and the sheet open on refusal.
describe('provider key sheet keeps the draft on a refused Save', () => {
  test('saveKey closes the sheet and reloads only after a successful save', () => {
    const saveKey = readSaveKey();
    const tryAt = saveKey.indexOf('try {');
    const finallyAt = saveKey.indexOf('} finally {');
    expect(tryAt).toBeGreaterThanOrEqual(0);
    expect(finallyAt).toBeGreaterThan(tryAt);
    const tryBlock = saveKey.slice(tryAt, finallyAt);
    expect(tryBlock).toContain('await client.setApiKey(id, value);');
    expect(tryBlock).toContain('setEditingId(null);');
    expect(tryBlock).toContain('void load();');
    const setKeyAt = tryBlock.indexOf('await client.setApiKey(id, value);');
    expect(tryBlock.indexOf('setEditingId(null);')).toBeGreaterThan(setKeyAt);
    expect(tryBlock.indexOf('void load();')).toBeGreaterThan(setKeyAt);
  });

  test('saveKey finally only clears busy — a refusal does not dismiss the sheet', () => {
    const saveKey = readSaveKey();
    const finallyAt = saveKey.indexOf('} finally {');
    expect(finallyAt).toBeGreaterThanOrEqual(0);
    const finallyBlock = saveKey.slice(finallyAt);
    expect(finallyBlock).toContain('setBusy(false);');
    expect(finallyBlock).not.toContain('setEditingId(null);');
    expect(finallyBlock).not.toContain('void load();');
  });

  test('a refused setApiKey still lands in the section ErrorCard', () => {
    const saveKey = readSaveKey();
    expect(saveKey).toContain('setError(caught instanceof Error ? caught.message : String(caught));');
  });

  test('the Save press does not clear the field before the Gate answers', () => {
    const press = readSavePress();
    expect(press).toContain('onSubmit(value);');
    expect(press).not.toContain("setValue('');");
  });

  test('closing the sheet still clears the field so a successful save never echoes the key', () => {
    const src = readSheet();
    expect(src).toContain('if (visible !== wasVisible)');
    expect(src).toContain("if (!visible) setValue('');");
  });

  test('a successful save still checks readiness and names ready / not-ready', () => {
    const saveKey = readSaveKey();
    expect(saveKey).toContain('const snapshot = await client.check(id);');
    expect(saveKey).toContain("if (snapshot.readiness?.state === 'ready')");
    expect(saveKey).toContain('setNotice(`${snapshot.label} is ready.`);');
    expect(saveKey).toContain(
      '`${snapshot.label}: ${snapshot.readiness?.message ?? snapshot.readiness?.state ?? \'not ready\'}`',
    );
  });

  test('the sheet copy and Cancel close stay byte-identical', () => {
    const sheet = readSheet();
    expect(sheet).toContain('Stored in the Gate vault and never shown again. The Gate checks it before this sheet closes.');
    expect(sheet).toContain('onClose={onClose}');
    expect(sheet).toContain('closeLabel="Cancel"');
    const section = readSection();
    expect(section).toContain('onSubmit={(value) => { if (editingId) void saveKey(editingId, value); }}');
    expect(section).toContain('onClose={() => setEditingId(null)}');
  });
});
