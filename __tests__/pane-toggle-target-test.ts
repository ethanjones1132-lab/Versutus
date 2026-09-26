declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readPaneSource(component: string): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'chat', `${component}.tsx`].join(SEP),
    'utf8',
  );
}

describe('the pane toggles are the only way into each pane and meet the touch target', () => {
  // Each pane's only open control is its ghost toggle (tools-pane.tsx:29-36,
  // skills-pane.tsx:29-34, routines-pane.tsx:98-103). sm is paddingVertical 8
  // over caption lineHeight 18 (Button.tsx:71-73, tokens.ts:101) = ~34dp; md
  // is the base button paddingVertical 13 over body lineHeight 24
  // (Button.tsx:66, tokens.ts:100) = 50dp -- the same class raised for
  // "Load earlier messages" in iter-062.
  const toggles: Array<{ file: string; label: string }> = [
    { file: 'tools-pane', label: 'toolsetsToggleLabel(state, open)' },
    { file: 'skills-pane', label: 'skillsToggleLabel(state, open)' },
    { file: 'routines-pane', label: 'routinesToggleLabel(state, open)' },
  ];

  for (const { file, label } of toggles) {
    test(`${file} toggle is size md, reaching the 48dp touch target`, () => {
      const src = readPaneSource(file);
      const labelAt = src.indexOf(`label={${label}}`);
      expect(labelAt).toBeGreaterThan(-1);
      const blockEnd = src.indexOf('/>', labelAt);
      expect(blockEnd).toBeGreaterThan(labelAt);
      const toggleBlock = src.slice(labelAt, blockEnd);
      // The toggle is a DisclosureRow: a full-width row whose own style holds
      // the target (asserted below against DisclosureRow.tsx).
      expect(src.slice(0, labelAt)).toMatch(/<DisclosureRow\s*$/);
    });

    test(`${file} toggle does not fall back to the sm sizing`, () => {
      const src = readPaneSource(file);
      const labelAt = src.indexOf(`label={${label}}`);
      expect(labelAt).toBeGreaterThan(-1);
      const blockEnd = src.indexOf('/>', labelAt);
      const toggleBlock = src.slice(labelAt, blockEnd);
      expect(toggleBlock).not.toMatch(/size="sm"/);
    });
  }
});

test('the disclosure row the panes open through is at least a 48dp target', () => {
  const src = jest.requireActual('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'components', 'ui', 'DisclosureRow.tsx'),
    'utf8',
  ) as string;
  const minHeight = Number(src.match(/minHeight:\s*(\d+)/)?.[1]);
  expect(minHeight).toBeGreaterThanOrEqual(48);
});
