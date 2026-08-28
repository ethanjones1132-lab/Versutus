declare const __dirname: string;
const SEP = __dirname.includes('\\\\') ? '\\\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readFile(relative: string): string {
  return nodeFs.readFileSync([__dirname, '..', ...relative.split('/')].join(SEP), 'utf8');
}

describe('environment run launcher sheet is scrollable on short phones', () => {
  test('launcher wraps prompt, log and actions in a ScrollView so Start run stays reachable', () => {
    const src = readFile('src/components/gateway/environment-run-launcher.tsx');
    expect(src).toContain('keyboardShouldPersistTaps="handled"');
    expect(src).toContain('showsVerticalScrollIndicator={false}');
    expect(src).toContain('contentContainerStyle={styles.scroll}');
    const outerIdx = src.indexOf('<ScrollView');
    const outerClose = src.lastIndexOf('</ScrollView>');
    const promptIdx = src.indexOf('placeholder="What should it do?"');
    expect(promptIdx).toBeGreaterThan(outerIdx);
    expect(promptIdx).toBeLessThan(outerClose);
    const startIdx = src.indexOf('label="Start run"');
    expect(startIdx).toBeGreaterThan(outerIdx);
    expect(startIdx).toBeLessThan(outerClose);
    const closeIdx = src.indexOf('label="Close"');
    expect(closeIdx).toBeGreaterThan(outerIdx);
    expect(closeIdx).toBeLessThan(outerClose);
  });

  test('launcher keeps the run title and workspace caption fixed above the scroll', () => {
    const src = readFile('src/components/gateway/environment-run-launcher.tsx');
    const titleIdx = src.indexOf('<Text variant="title">');
    const captionIdx = src.indexOf('environment.workspacePolicy.defaultSandbox');
    const outerIdx = src.indexOf('<ScrollView');
    expect(titleIdx).toBeGreaterThan(-1);
    expect(titleIdx).toBeLessThan(outerIdx);
    expect(captionIdx).toBeGreaterThan(-1);
    expect(captionIdx).toBeLessThan(outerIdx);
  });

  test('launcher keeps the event-log ScrollView nested inside the outer one', () => {
    const src = readFile('src/components/gateway/environment-run-launcher.tsx');
    const opens = src.match(/<ScrollView/g) ?? [];
    expect(opens.length).toBe(2);
    const outerIdx = src.indexOf('<ScrollView');
    const innerIdx = src.indexOf('<ScrollView', outerIdx + 1);
    const innerClose = src.indexOf('</ScrollView>');
    const outerClose = src.lastIndexOf('</ScrollView>');
    expect(innerIdx).toBeGreaterThan(outerIdx);
    expect(innerClose).toBeGreaterThan(innerIdx);
    expect(innerClose).toBeLessThan(outerClose);
    // the 240px log scrolls inside the outer sheet scroll on Android only
    // with nested scrolling enabled (skills/routines pane idiom, iter-054)
    expect(src).toContain('nestedScrollEnabled');
  });

  test('launcher imports ScrollView from react-native', () => {
    const src = readFile('src/components/gateway/environment-run-launcher.tsx');
    expect(src).toMatch(/import[^;]*ScrollView[^;]*from 'react-native'/);
  });
});