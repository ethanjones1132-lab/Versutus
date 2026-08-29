declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  // Both components are CRLF on disk; normalize so the block regexes below
  // do not depend on the file's line endings (iter-072 lesson).
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('cron section refresh', () => {
  test('the section re-reads jobs when the Activity tab regains focus', () => {
    // A routine that starts or finishes while the tab is open must not keep
    // its old verdict (● running / Not running) until the tab remounts.
    const src = readSource(
      'src',
      'components',
      'activity',
      'cron-section.tsx',
    );
    expect(src).toMatch(/import \{ useFocusEffect \} from 'expo-router';/);
    const focusEffect = src.match(
      /useFocusEffect\(\s*useCallback\(\(\) => \{\s*void load\(\);\s*\}, \[load\]\),\s*\);?/,
    )?.[0];
    expect(focusEffect).toBeDefined();
  });

  test('a reload signal from the Activity pull-to-refresh reaches the section', () => {
    const src = readSource(
      'src',
      'components',
      'activity',
      'cron-section.tsx',
    );
    // The section takes the signal and folds it into its loader deps so a
    // refresh without a remount still re-lists jobs.
    expect(src).toMatch(/export function CronSection\(\{ cronReloadSignal = 0 \}/);
    // The signal folds into the mounted/focus effect, not the loader's own
    // deps (the loader does not read it — keeping it there trips the
    // exhaustive-deps lint as an unnecessary dependency).
    expect(src).toMatch(/}, \[load, cronReloadSignal\]\);/);
  });

  test('Activity bumps the cron reload signal on pull-to-refresh and passes it down', () => {
    const src = readSource('src', 'app', '(tabs)', 'activity.tsx');
    expect(src).toMatch(
      /const \[cronReloadSignal, setCronReloadSignal\] = useState\(0\);/,
    );
    // onRefresh reaches the cron re-read...
    expect(src).toMatch(/setCronReloadSignal\(\(n\) => n \+ 1\)/);
    // ...and the section receives the signal.
    expect(src).toMatch(/<CronSection cronReloadSignal=\{cronReloadSignal\} \/>/);
  });
});
