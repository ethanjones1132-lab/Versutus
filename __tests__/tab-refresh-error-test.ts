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

function readActivity(): string {
  return readSource(['src', 'app', '(tabs)', 'activity.tsx']);
}

function readRuns(): string {
  return readSource(['src', 'app', 'runs.tsx']);
}

function readHome(): string {
  return readSource(['src', 'app', '(tabs)', 'index.tsx']);
}

function onRefreshBody(src: string): string {
  const match = src.match(/const onRefresh = async \(\) => \{[\s\S]*?\n  \};/);
  expect(match).not.toBeNull();
  return match![0];
}

const REFRESH_STATE = "const [refreshError, setRefreshError] = useState<string | null>(null);";

// A pull-to-refresh folds every rejection into `undefined` and then ends the
// spinner unconditionally, so the operator sees the refresh "succeed" on a
// failed read. Each of the three tab screens must capture the refusal, clear
// it on the next success, and surface it below the header as the repo's
// ErrorCard — while the 400 ms spinner hold and the reload-signal bumps stay.
describe('tab pull-to-refresh failure is surfaced', () => {
  test.each([
    ['activity', readActivity],
    ['runs', readRuns],
    ['home', readHome],
  ])('%s declares a refreshError state', (_name, read) => {
    expect(read()).toContain(REFRESH_STATE);
  });

  test.each([
    ['activity', readActivity],
    ['runs', readRuns],
    ['home', readHome],
  ])('%s onRefresh captures the rejection instead of swallowing it', (_name, read) => {
    const body = onRefreshBody(read());
    expect(body).not.toMatch(/\.catch\(\(\) => undefined\)/);
    expect(body).toMatch(/setRefreshError\(/);
    expect(body).toMatch(/setRefreshError\(null\)/);
  });

  test.each([
    ['activity', readActivity],
    ['runs', readRuns],
    ['home', readHome],
  ])('%s renders an ErrorCard gated on refreshError', (_name, read) => {
    const src = read();
    expect(src).toMatch(/refreshError \? \(\s*<ErrorCard/);
    expect(src).toContain('onDismiss={() => setRefreshError(null)}');
    expect(src).toContain('onRetry={() => void onRefresh()}');
  });

  test('the Activity notice renders below the title row and above the runs entry card', () => {
    const src = readActivity();
    const titleAt = src.indexOf('<Text variant="title">Activity</Text>');
    const errorAt = src.indexOf('refreshError ? (');
    const entryAt = src.indexOf('styles.runsEntryCard');
    expect(titleAt).toBeGreaterThanOrEqual(0);
    expect(errorAt).toBeGreaterThan(titleAt);
    expect(entryAt).toBeGreaterThan(errorAt);
  });

  test('the Runs notice renders below the title row and above the start card', () => {
    const src = readRuns();
    const titleAt = src.indexOf('<Text variant="title">Runs</Text>');
    const errorAt = src.indexOf('refreshError ? (');
    const startAt = src.indexOf('styles.startCard');
    expect(titleAt).toBeGreaterThanOrEqual(0);
    expect(errorAt).toBeGreaterThan(titleAt);
    expect(startAt).toBeGreaterThan(errorAt);
  });

  test('the Home notice renders below the ScreenHeader and above the dashboard', () => {
    const src = readHome();
    const headerAt = src.indexOf('<ScreenHeader');
    const errorAt = src.indexOf('refreshError ? (');
    const dashAt = src.indexOf('<GatewayHomeDashboard');
    expect(headerAt).toBeGreaterThanOrEqual(0);
    expect(errorAt).toBeGreaterThan(headerAt);
    expect(dashAt).toBeGreaterThan(errorAt);
  });

  test('all three keep the 400 ms minimum spinner hold', () => {
    for (const read of [readActivity, readRuns, readHome]) {
      expect(onRefreshBody(read())).toContain('400 - elapsed');
    }
  });

  test('Activity still re-reads the audit and bumps the cron reload signal', () => {
    const body = onRefreshBody(readActivity());
    expect(body).toContain('await readAudit();');
    expect(body).toContain('setCronReloadSignal((n) => n + 1);');
  });

  test('Runs still bumps the runs reload signal', () => {
    expect(onRefreshBody(readRuns())).toContain('setRunsReloadSignal((n) => n + 1);');
  });

  test('Home still folds reloadHistory into the same refresh', () => {
    expect(onRefreshBody(readHome())).toContain('reloadHistory()');
  });
});
