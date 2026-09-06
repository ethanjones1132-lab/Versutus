declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function slashSuggestionsBlock(): string {
  const src = readSource(['src', 'components', 'chat', 'chat-screen.tsx']);
  const start = src.indexOf('const slashSuggestions = ');
  expect(start).toBeGreaterThanOrEqual(0);
  // The memo closes with its dependency array; slice generously past it but
  // before the neighbouring quickActions memo so assertions stay local.
  const quickActions = src.indexOf('const quickActions', start);
  expect(quickActions).toBeGreaterThan(start);
  return src.slice(start, quickActions);
}

test('slashSuggestions memoizes the registry build instead of running it per render', () => {
  const block = slashSuggestionsBlock();
  expect(block).toContain('useMemo(');
  expect(block).toContain('getSlashCommandSuggestions(');
});

test('slashSuggestions re-derives on every registry input', () => {
  const block = slashSuggestionsBlock();
  expect(block).toContain('draft,');
  expect(block).toContain('activeHello,');
  expect(block).toContain('recentCommands,');
  expect(block).toContain('capabilitySnapshot.methods,');
  expect(block).toContain('dynamicCommands,');
  expect(block).toContain('skillsState.skills');
});

test('slashSuggestions still caps the composer strip at 12 rows', () => {
  const block = slashSuggestionsBlock();
  // The browsable palette takes Infinity; the composer strip keeps its cap.
  expect(block).toContain('12,');
  expect(block).not.toContain('Number.POSITIVE_INFINITY');
  expect(block).toContain("startsWith('/')");
});
