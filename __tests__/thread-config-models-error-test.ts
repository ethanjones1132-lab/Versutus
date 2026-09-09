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

// A refused model-catalog read was caught with a bare `catch {}` that
// discarded the reason, and ModelsSection rendered the same "not reported
// yet" empty state for a refusal as for a gateway that never reported one.
// The refusal is now tracked beside the catalog and rendered with a retry.
describe('thread config models error', () => {
  test('the model-picker catch is not bare: the refusal is kept as state', () => {
    const src = readProvider();
    const picker = src.match(
      /const openModelPicker = useCallback\(async \(mode[\s\S]*?\n  \}, \[\]\);/,
    )?.[0];
    expect(picker).toBeDefined();
    expect(picker).not.toMatch(/catch \{\s*\/\/ Keep picker usable/);
    expect(picker).toContain('setModelCatalogError');
  });

  test('a refused read sets the error and a success or fresh open clears it', () => {
    const src = readProvider();
    expect(src).toContain('const [modelCatalogError, setModelCatalogError]');
    const picker = src.match(
      /const openModelPicker = useCallback\(async \(mode[\s\S]*?\n  \}, \[\]\);/,
    )?.[0];
    expect(picker).toBeDefined();
    expect(picker).toContain('const message = error instanceof Error ? error.message : String(error);');
    expect(picker).toContain("setModelCatalogError(message || 'Model catalog could not be read.');");
    expect(picker).toContain('setModelCatalog(models);\n      setModelCatalogError(undefined);');
    expect(picker).toContain('setModelCatalogError(undefined);\n    const client = clientRef.current;');
  });

  test('the model read sequence guard still owns both landings', () => {
    const src = readProvider();
    const picker = src.match(
      /const openModelPicker = useCallback\(async \(mode[\s\S]*?\n  \}, \[\]\);/,
    )?.[0];
    expect(picker).toBeDefined();
    expect(picker).toContain('const seq = modelReadSeqRef.current + 1;');
    expect(picker).toContain('setModelCatalog(models);');
    // A superseded read must not settle state — success or refusal.
    expect(picker).toMatch(
      /if \(seq !== modelReadSeqRef\.current\) return;\s*setModelCatalog\(models\);/,
    );
    expect(picker).toMatch(
      /catch \(error\) \{\s*if \(seq !== modelReadSeqRef\.current\) return;/,
    );
  });

  test('a refusal never clears the cached catalog', () => {
    const src = readProvider();
    const picker = src.match(
      /const openModelPicker = useCallback\(async \(mode[\s\S]*?\n  \}, \[\]\);/,
    )?.[0];
    expect(picker).toBeDefined();
    expect(picker).not.toContain('setModelCatalog([])');
    // The sheet keeps the list on screen and names the staleness above it,
    // the way the sessions section does.
    const sheet = readSheet();
    expect(sheet).toContain('{modelsError && models.length > 0 ? (');
    expect(sheet).toContain('{modelsError}');
  });

  test('an empty cache names the refusal instead of "not reported yet"', () => {
    const sheet = readSheet();
    expect(sheet).toContain("title={modelsError ?? 'No models found'}");
    expect(sheet).toMatch(
      /description=\{\s*modelsError\s*\? undefined\s*: 'The gateway has not reported a model catalog yet\. Refresh to ask again\.'\s*\}/,
    );
    expect(sheet).toContain('modelsError?: string;');
  });

  test('the refusal reaches the section through the existing refresh retry', () => {
    const sheet = readSheet();
    expect(sheet).toContain('modelsError={modelsError}');
    expect(sheet).toContain('onRefresh={onRefreshModels}');
    const screen = readScreen();
    expect(screen).toContain('modelsError={modelCatalogError}');
    expect(screen).toMatch(
      /onRefreshModels=\{\(\) => \{\s*closeModelPicker\(\);\s*void openModelPicker\(modelPicker\.mode, modelPicker\.agentId\);\s*\}\}/,
    );
    const provider = readProvider();
    expect(provider).toContain('modelCatalogError,');
    expect(provider).toContain('modelCatalogError?: string;');
  });

  test('the loaded-but-filtered "No matches" copy stays untouched', () => {
    const sheet = readSheet();
    expect(sheet).toContain('title="No matches"');
    expect(sheet).toContain('description={`Nothing in the catalog matches');
    expect(sheet).toContain('actionLabel="Clear search"');
    expect(sheet).toContain('onAction={() => setQuery(\'\')}');
  });
});
