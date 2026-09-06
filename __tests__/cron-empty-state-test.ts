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

const section = () =>
  readSource('src', 'components', 'activity', 'cron-section.tsx');

test('the empty gateway job list renders the shared EmptyState, not a bare line', () => {
  const src = section();
  expect(src).toContain('<EmptyState');
  expect(src).toContain('No scheduled work on this gateway');
  // The old bare-caption empty branch is gone.
  expect(src).not.toContain('variant="caption" color="secondary"');
});

test('the empty state names the create form below as the way to file work', () => {
  const src = section();
  expect(src).toMatch(/File scheduled work with the New scheduled job form below\./);
  // The guidance sits above the list; the form heading sits below it.
  const emptyIdx = src.indexOf('<EmptyState');
  const listIdx = src.indexOf('sorted.map((job)');
  const createIdx = src.lastIndexOf('New scheduled job');
  expect(emptyIdx).toBeGreaterThan(-1);
  expect(listIdx).toBeGreaterThan(-1);
  expect(emptyIdx).toBeLessThan(listIdx);
  expect(createIdx).toBeGreaterThan(listIdx);
});

test('the empty state leaves the ErrorCard-with-retry failure path alone', () => {
  const src = section();
  expect(src).toContain('<ErrorCard');
  expect(src).toContain('onRetry={() => void load()}');
  expect(src).toContain('affected="Scheduled work on this gateway"');
});

test('the empty state leaves the create form and its draft-keeps-on-refusal path alone', () => {
  const src = section();
  expect(src).toContain('New scheduled job');
  expect(src).toContain('botJobs.create(gatewayJobInput(submitted))');
  expect(src).toContain('applyRoutineCreate(submitted, { ok: false, cause })');
  expect(src).toContain('setCreateError(next.error)');
});
