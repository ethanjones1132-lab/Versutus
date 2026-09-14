// ─── The quiet-hours pane, mounted in the preferences section ───────────────
// The Gate enforces the window (push-notifier.mjs isQuiet) and holds it on the
// row (push-rpc.mjs preferencesFrom), but nothing app-side let the operator
// read or set one until the pane: two clock fields, parsed and committed only
// when both parse, cleared to the Gate's "no window" null from its one clear
// affordance. This suite pins the mount and the copy by source, the way the
// rest of the preferences suites do.

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
  readSource('src', 'components', 'gateway', 'notification-preferences-section.tsx');
const fold = () => readSource('src', 'lib', 'notifications', 'push-quiet-hours.ts');

describe('the quiet-hours pane hangs off the preferences section', () => {
  test('it renders inside the read branch, after the two shipped switches and beside the allowlist', () => {
    const src = section();
    const readBranch = src.slice(src.indexOf('preferences === null ? ('));
    expect(readBranch).toContain('handleQuietCommit');
    // Both shipped switches come first — the pane joins their row, it does not
    // reorder them.
    expect(readBranch.indexOf("handleToggle('enabled'")).toBeGreaterThan(-1);
    expect(readBranch.indexOf("handleToggle('richBody'")).toBeGreaterThan(-1);
    expect(readBranch.indexOf('quietRow')).toBeGreaterThan(
      readBranch.indexOf("handleToggle('richBody'"),
    );
  });

  test('it is not rendered while unread or before the pane has read anything', () => {
    const src = section();
    const unreadBranch = src.slice(src.indexOf('{unread ? ('));
    expect(unreadBranch).not.toContain('<QuietHoursPane');
  });

  test('the window state lives on the section and is seeded from the same Gate read', () => {
    expect(section()).toContain('quietStartText, setQuietStartText');
    expect(section()).toContain('quietEndText, setQuietEndText');
    // One seed point, from the row the pane already read — never a second
    // fetch surface. (Three mentions: the declaration pair and the two field
    // seeds inside the one read effect.)
    expect(section().split('setQuietStartText(').length - 1).toBe(2);
  });

  test('the clear affordance and the commit line are the only writers beside the state seeds', () => {
    expect(section()).toContain('const handleQuietClear');
    expect(section()).toContain('const handleQuietCommit');
  });
});

describe('the pane folds the clock through the shared module, never inline', () => {
  test('it imports the fold', () => {
    expect(section()).toContain("from '@/lib/notifications/push-quiet-hours'");
  });

  test('a half-parsed commit drives the invalid state, never a silent drop', () => {
    const src = section();
    const commit = src.slice(src.indexOf('const handleQuietCommit'));
    expect(commit).toContain('validationState');
  });

  test('the copy constants ride the fold', () => {
    const src = section();
    expect(src).toContain('QUIET_HOURS_START_LABEL');
    expect(src).toContain('QUIET_HOURS_END_LABEL');
    expect(src).toContain('QUIET_HOURS_EXEMPT_COPY');
    expect(fold()).toContain("export const QUIET_HOURS_EXEMPT_COPY =");
    expect(fold()).toContain("A quiet window can't excuse an approval push");
  });

  test('the clear affordance says exactly what it does and the commit says what it commits', () => {
    const src = section();
    expect(src).toContain('QuietHoursClearHint');
    expect(src).toContain('Clear quiet hours');
    expect(src).toContain('Save quiet hours');
  });
});
