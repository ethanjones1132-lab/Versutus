declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readProvider(): string {
  return readSource(['src', 'context', 'gateway-provider.tsx']);
}

function readSheet(): string {
  return readSource(['src', 'components', 'chat', 'thread-config-sheet.tsx']);
}

function readScreen(): string {
  return readSource(['src', 'components', 'chat', 'chat-screen.tsx']);
}

function modelPickerSlice(provider: string): string {
  const picker = provider.match(
    /const openModelPicker = useCallback\(async \(mode[\s\S]*?\n  \}, \[\]\);/,
  )?.[0];
  expect(picker).toBeDefined();
  return picker!;
}

// The sheet opens before `getModels()` answers (sheet-open-before-read), so a
// cold open rendered `models.length === 0` through the empty branch and
// greeted the operator with "No models found" while the read was still in
// flight. `modelsLoaded` is the same gate the sessions section already uses
// in this file: empty + unloaded + unfailed is "still reading", not "none".
describe('thread config models loading', () => {
  test('the provider tracks a settled catalog read beside the catalog', () => {
    const src = readProvider();
    expect(src).toContain('const [modelCatalogLoaded, setModelCatalogLoaded] = useState(false);');
    expect(src).toContain('modelCatalogLoaded: boolean;');
    expect(src).toMatch(/modelCatalogError,\n\s+modelCatalogLoaded,/);
  });

  test('every settling path of openModelPicker marks the read settled', () => {
    const picker = modelPickerSlice(readProvider());
    // Success arm: catalog + error clear, then settled.
    expect(picker).toContain(
      'setModelCatalog(models);\n      setModelCatalogError(undefined);\n      setModelCatalogLoaded(true);',
    );
    // Refusal arm: the message is kept AND the read is settled (so the empty
    // branch can show the refusal instead of spinning).
    expect(picker).toMatch(
      /catch \(error\) \{[\s\S]*?setModelCatalogError\(message \|\| 'Model catalog could not be read\.'\);\n      setModelCatalogLoaded\(true\);/,
    );
    // No client means no read will ever be issued — it must not spin forever.
    expect(picker).toMatch(/if \(!client\) \{\s*setModelCatalogLoaded\(true\);\s*return;\s*\}/);
    // A superseded read must not settle state.
    expect(picker).toMatch(
      /if \(seq !== modelReadSeqRef\.current \|\| !isCurrent\(\)\) return;[\s\S]*?setModelCatalogLoaded\(true\);/,
    );
    expect(picker).not.toMatch(
      /if \(seq !== modelReadSeqRef\.current \|\| !isCurrent\(\)\) return;[\s\S]{0,40}setModelCatalogLoaded\(true\);[\s\S]*?setModelCatalog\(models\)/,
    );
  });

  test('the sheet declares and forwards modelsLoaded to the section', () => {
    const sheet = readSheet();
    expect(sheet).toContain('modelsLoaded?: boolean;');
    expect(sheet).toMatch(/modelsError,\n\s+modelsLoaded,/);
    expect(sheet).toContain('modelsLoaded={modelsLoaded}');
  });

  test('an unloaded empty catalog reads as in-flight, never as "No models found"', () => {
    const sheet = readSheet();
    expect(sheet).toContain(
      '{models.length === 0 && !modelsLoaded && !modelsError ? (',
    );
    expect(sheet).toContain('title="Reading models…"');
    // The confident empty claim sits on the settled branch behind the guard.
    const guardIdx = sheet.indexOf('{models.length === 0 && !modelsLoaded && !modelsError ? (');
    const emptyIdx = sheet.indexOf("title={modelsError ?? 'No models found'}");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(emptyIdx).toBeGreaterThan(guardIdx);
    // The sessions sibling gate stays intact — this file already solved it.
    expect(sheet).toContain('{sessions.length === 0 && !sessionsLoaded && !sessionsError ? (');
  });

  test('a settled refusal still names the failure instead of reading as loading', () => {
    const sheet = readSheet();
    // `!modelsError` in the guard: a kept refusal skips the reading branch.
    expect(sheet).toContain('{models.length === 0 && !modelsLoaded && !modelsError ? (');
    expect(sheet).toContain("title={modelsError ?? 'No models found'}");
    expect(sheet).toMatch(
      /description=\{\s*modelsError\s*\? undefined\s*: 'The gateway has not reported a model catalog yet\. Refresh to ask again\.'\s*\}/,
    );
  });

  test('chat screen threads the settled flag into the sheet', () => {
    const screen = readScreen();
    expect(screen).toContain('modelCatalogLoaded,');
    expect(screen).toContain('modelsLoaded={modelCatalogLoaded}');
    expect(screen).toContain('modelsError={modelCatalogError}');
  });

  test('keep-working: search, refresh, and error-copy wiring stay put', () => {
    const sheet = readSheet();
    expect(sheet).toContain('modelsError={modelsError}');
    expect(sheet).toContain('onRefresh={onRefreshModels}');
    expect(sheet).toContain('title="No matches"');
    expect(sheet).toContain('actionLabel="Clear search"');
    const screen = readScreen();
    expect(screen).toMatch(
      /onRefreshModels=\{\(\) => \{\s*closeModelPicker\(\);\s*void openModelPicker\(modelPicker\.mode, modelPicker\.agentId\);\s*\}\}/,
    );
  });
});
