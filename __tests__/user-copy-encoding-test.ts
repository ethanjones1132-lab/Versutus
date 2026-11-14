import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

const root = path.join(__dirname, '..');
// Signatures from the demonstrated double-decoded separators, with escaped
// code points so the guard's own source cannot be damaged by a shell encoding.
const corrupted = /\u00c2[\u00a0-\u00bf]|\u00e2\u20ac[\u0090-\u00ff\u2010-\u203f]|\u00f0\u0178/;

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(relative) : /\.tsx?$/.test(entry.name) ? [relative] : [];
  });
}

test('shipped screen copy contains no demonstrated mojibake signatures', () => {
  const failures: string[] = [];
  for (const file of [...sourceFiles('src/components'), ...sourceFiles('src/app')]) {
    const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node): void => {
      let text: string | undefined;
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) text = node.text;
      else if (ts.isJsxText(node)) text = node.text;
      if (text && corrupted.test(text)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        failures.push(`${file}:${line}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(failures).toEqual([]);
});

test('the narrow guard catches the original separators and allows real Unicode', () => {
  expect(corrupted.test('3 runs \u00c2\u00b7 8 sessions')).toBe(true);
  expect(corrupted.test('Could not refresh \u00e2\u20ac\u201d showing the last read.')).toBe(true);
  for (const text of ['3 runs · 8 sessions', 'Could not refresh — showing the last read.', 'Café · 日本語 · العربية · 👍🏽']) {
    expect(corrupted.test(text)).toBe(false);
  }
});
