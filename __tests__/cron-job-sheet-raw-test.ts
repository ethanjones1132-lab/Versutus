declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readFile(relative: string): string {
  return nodeFs.readFileSync([__dirname, '..', ...relative.split('/')].join(SEP), 'utf8');
}

describe('cron job sheet raw record is bounded so run history stays reachable', () => {
  test('the raw JSON record renders inside a ScrollView, not a bare unscoped Text block', () => {
    const src = readFile('src/components/activity/cron-job-sheet.tsx');
    // The raw record must be wrapped in a scrollable, capped container so a
    // 60+ line record cannot shove RUN HISTORY off-screen.
    expect(src).toContain('<ScrollView style={styles.rawScroll} nestedScrollEnabled>');
    // The record itself (JSON.stringify of the raw job) lives inside that scroll.
    const scrollIdx = src.indexOf('<ScrollView style={styles.rawScroll}');
    const rawIdx = src.indexOf('JSON.stringify(job.raw ?? job, null, 2)');
    const closeIdx = src.indexOf('</ScrollView>');
    expect(scrollIdx).toBeGreaterThan(-1);
    expect(rawIdx).toBeGreaterThan(scrollIdx);
    expect(rawIdx).toBeLessThan(closeIdx);
    // And the whole thing is framed by a capped card, not dropped straight in
    // the sheet's own ScrollView as a free-floating Text.
    const cardIdx = src.indexOf('styles.rawCard');
    expect(cardIdx).toBeGreaterThan(-1);
    expect(cardIdx).toBeLessThan(scrollIdx);
  });

  test('the raw scroll container carries a maxHeight cap', () => {
    const src = readFile('src/components/activity/cron-job-sheet.tsx');
    const scrollStyle = src.slice(src.indexOf('rawScroll: {'), src.indexOf('rawScroll: {') + 80);
    expect(scrollStyle).toContain('maxHeight');
  });

  test('cron-job-sheet imports ScrollView from react-native', () => {
    const src = readFile('src/components/activity/cron-job-sheet.tsx');
    expect(src).toMatch(/import[^;]*ScrollView[^;]*from 'react-native'/);
  });
});
