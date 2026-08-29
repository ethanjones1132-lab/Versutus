declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readResultSource(): string {
  // command-result-view.tsx is CRLF on disk; normalize so matchers below do
  // not depend on the file's line endings.
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'terminal', 'command-result-view.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

// A long RPC result (list/help/verbose dump) shown inline in the terminal card
// is clipped to eight lines with no way to read the rest (RPC_RESULT_PREVIEW_LINES
// = 8, command-result-view.tsx:13/:27). The full result lives only in the sheet
// (command-log-sheet.tsx:79), a separate navigation; inline there is no recovery.
// Mirror the tool-call-card / message-bubble rawScroll idiom: bound the preview
// in a capped, scrollable teaser so the rest is reachable on the phone without
// leaving the inline card. The non-preview (sheet) path is untouched.
describe('command result preview is bounded so a long dump is reachable', () => {
  test('the preview text renders inside a ScrollView, not a bare numberOfLines={8} clamp', () => {
    const src = readResultSource();
    expect(src).toContain('<ScrollView style={styles.previewScroll} nestedScrollEnabled>');
    const scrollIdx = src.indexOf('<ScrollView style={styles.previewScroll}');
    const textIdx = src.indexOf('{model.text}');
    const closeIdx = src.indexOf('</ScrollView>');
    expect(scrollIdx).toBeGreaterThan(-1);
    expect(textIdx).toBeGreaterThan(scrollIdx);
    expect(textIdx).toBeLessThan(closeIdx);
    // The bare 8-line clamp must be gone from the preview path.
    expect(src).not.toContain('numberOfLines={preview ? RPC_RESULT_PREVIEW_LINES : undefined}');
  });

  test('the preview scroll container carries a maxHeight cap', () => {
    const src = readResultSource();
    const scrollStyle = src.slice(
      src.indexOf('previewScroll: {'),
      src.indexOf('previewScroll: {') + 80,
    );
    expect(scrollStyle).toContain('maxHeight');
  });

  test('command-result-view imports ScrollView from react-native', () => {
    const src = readResultSource();
    expect(src).toMatch(/import[^;]*ScrollView[^;]*from 'react-native'/);
  });
});
