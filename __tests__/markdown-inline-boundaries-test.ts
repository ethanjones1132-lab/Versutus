/**
 * VS-004: inline emphasis must not eat arithmetic or Python dunders.
 *
 * QUALITY-SCAN-2026-10-11 (near 1307-1317) confirmed two MED text-corruption
 * bugs in `parseInline`:
 *
 * - `*` opened at any position and accepted a closer preceded by whitespace,
 *   so "2 * 3 * 4" rendered as "2 " + italic " 3 " + " 4".
 * - `__` opened bold anywhere, so "__init__.py" rendered as bold "init".
 *
 * The fixes apply CommonMark-style flanking (no opener followed by whitespace,
 * no closer preceded by whitespace) plus an explicit dunder-pair test, because
 * a simple "word character before the opener" rule cannot save "__init__.py"
 * at the start of the text. These tests drive the production `parseInline`
 * (and the real MarkdownText tree) so a source-string pin cannot pass for them.
 *
 * Deliberate product decision: a bare single-token dunder (`__name__`,
 * `__init__`, `__bold__`) reads as an identifier and stays literal. Prose
 * emphasis with underscores needs a space in the content (`__bold text__`),
 * which is the form agents use for running prose.
 */

// The design tokens import native easing; use the neighboring markdown test seam.
jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
}));

jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(async () => undefined),
}));

// The kit barrel reaches native primitives this test does not exercise.
jest.mock('@/components/ui', () => ({ Divider: 'Divider' }));

// Code fences are not part of these inputs; the block's chrome is not either.
jest.mock('@/components/chat/markdown/code-block', () => ({ CodeBlock: 'CodeBlock' }));

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { MarkdownText } from '@/components/chat/markdown/markdown-text';
import { parseInline, parseMarkdown, type MdInline } from '@/components/chat/markdown/parser';

/** The characters an operator actually sees, in order. */
function visible(spans: MdInline[]): string {
  return spans.map((span) => span.text).join('');
}

function paragraphText(text: string): string {
  const block = parseMarkdown(text)[0];
  if (block?.type !== 'paragraph') throw new Error(`expected a paragraph, got ${block?.type}`);
  return visible(block.spans);
}

function render(text: string): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(createElement(MarkdownText, { text }));
  });
  return renderer;
}

/** Every string in the rendered tree, in document order. */
function renderedStrings(renderer: ReactTestRenderer): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer.toJSON());
  return out;
}

describe('single asterisks keep arithmetic literal', () => {
  test('"2 * 3 * 4" survives with its stars and no emphasis span', () => {
    // Pre-fix this was [{text:'2 '},{text:' 3 ',italic:true},{text:' 4'}].
    expect(parseInline('2 * 3 * 4')).toEqual([{ text: '2 * 3 * 4' }]);
  });

  test('whitespace-surrounded standalone stars and near-misses stay literal', () => {
    expect(parseInline('a * b')).toEqual([{ text: 'a * b' }]);
    expect(parseInline('a * b * c')).toEqual([{ text: 'a * b * c' }]);
    expect(parseInline('* lone *')).toEqual([{ text: '* lone *' }]);
    expect(parseInline('2 * 3')).toEqual([{ text: '2 * 3' }]);
    expect(parseInline('*')).toEqual([{ text: '*' }]);
    expect(parseInline('1 * 2 * 3 = 6')).toEqual([{ text: '1 * 2 * 3 = 6' }]);
  });

  test('the opener may not be followed by whitespace', () => {
    expect(parseInline('* not opened*')).toEqual([{ text: '* not opened*' }]);
  });

  test('the closer may not be preceded by whitespace', () => {
    expect(parseInline('*not closed *')).toEqual([{ text: '*not closed *' }]);
    expect(parseInline('_not closed _')).toEqual([{ text: '_not closed _' }]);
  });
});

describe('genuine asterisk emphasis still works', () => {
  test('a well-formed italic span is parsed', () => {
    expect(parseInline('*italic*')).toEqual([{ text: 'italic', italic: true }]);
    expect(parseInline('*italic text*')).toEqual([{ text: 'italic text', italic: true }]);
    expect(parseInline('say *italic* now')).toEqual([
      { text: 'say ' },
      { text: 'italic', italic: true },
      { text: ' now' },
    ]);
  });

  test('bold keeps working, including nested italic', () => {
    expect(parseInline('**bold**')).toEqual([{ text: 'bold', bold: true }]);
    expect(parseInline('a **bold** and `code`')).toEqual([
      { text: 'a ' },
      { text: 'bold', bold: true },
      { text: ' and ' },
      { text: 'code', code: true },
    ]);
    expect(parseInline('**bold with *inner italic* text**')).toEqual([
      { text: 'bold with ', bold: true },
      { text: 'inner italic', bold: true, italic: true },
      { text: ' text', bold: true },
    ]);
  });

  test('ordinary underscores keep their old behavior', () => {
    expect(parseInline('some_snake_case')).toEqual([{ text: 'some_snake_case' }]);
    expect(parseInline('a _real italic_ word')).toEqual([
      { text: 'a ' },
      { text: 'real italic', italic: true },
      { text: ' word' },
    ]);
  });
});

describe('Python dunders survive inline parsing', () => {
  test('a filename dunder keeps both underscore pairs at the start of text', () => {
    // Pre-fix this was [{text:'init',bold:true},{text:'.py'}]. The opener has
    // no preceding character at all, so "check the character before __" fails.
    expect(parseInline('__init__.py')).toEqual([{ text: '__init__.py' }]);
  });

  test('module dunders and dunder methods stay literal in prose', () => {
    expect(parseInline('__name__')).toEqual([{ text: '__name__' }]);
    expect(parseInline('__main__')).toEqual([{ text: '__main__' }]);
    expect(parseInline('the __init__ method')).toEqual([{ text: 'the __init__ method' }]);
    expect(parseInline('call __getitem__ here')).toEqual([
      { text: 'call __getitem__ here' },
    ]);
    expect(parseInline('obj.__class__')).toEqual([{ text: 'obj.__class__' }]);
    expect(parseInline('super().__init__()')).toEqual([{ text: 'super().__init__()' }]);
    expect(parseInline('__name__ == "__main__"')).toEqual([
      { text: '__name__ == "__main__"' },
    ]);
  });

  test('intraword double underscores stay literal', () => {
    expect(parseInline('foo__bar__baz')).toEqual([{ text: 'foo__bar__baz' }]);
    expect(parseInline('some__thing__else')).toEqual([{ text: 'some__thing__else' }]);
  });

  test('dunders inside genuine bold text do not close the bold early', () => {
    expect(parseInline('__bold with __init__.py inside__')).toEqual([
      { text: 'bold with __init__.py inside', bold: true },
    ]);
  });

  test('prose bold with underscores still works', () => {
    expect(parseInline('__bold text__')).toEqual([{ text: 'bold text', bold: true }]);
    expect(parseInline('then __bold text__ now')).toEqual([
      { text: 'then ' },
      { text: 'bold text', bold: true },
      { text: ' now' },
    ]);
  });
});

describe('protection paths are unchanged', () => {
  test('inline code keeps stars and dunders verbatim', () => {
    expect(parseInline('`2 * 3 * 4`')).toEqual([{ text: '2 * 3 * 4', code: true }]);
    expect(parseInline('`__init__.py`')).toEqual([{ text: '__init__.py', code: true }]);
  });

  test('link labels keep stars and dunders verbatim', () => {
    expect(parseInline('[__init__.py](https://example.test)')).toEqual([
      { text: '__init__.py', link: 'https://example.test' },
    ]);
    expect(parseInline('[2 * 3](https://example.test)')).toEqual([
      { text: '2 * 3', link: 'https://example.test' },
    ]);
  });

  test('strikethrough is untouched', () => {
    expect(parseInline('~~old~~')).toEqual([{ text: 'old', strike: true }]);
  });
});

describe('mixed agent prose keeps every model-written character', () => {
  const MIXED =
    'Compute 2 * 3 * 4, keep __init__.py and __name__, but *emphasise this* and __bold this text__.';

  test('parseInline splits on the real delimiters only', () => {
    expect(parseInline(MIXED)).toEqual([
      { text: 'Compute 2 * 3 * 4, keep __init__.py and __name__, but ' },
      { text: 'emphasise this', italic: true },
      { text: ' and ' },
      { text: 'bold this text', bold: true },
      { text: '.' },
    ]);
  });

  test('the preserved text reaches a paragraph span through parseMarkdown', () => {
    expect(paragraphText(MIXED)).toBe(
      'Compute 2 * 3 * 4, keep __init__.py and __name__, but emphasise this and bold this text.',
    );
  });

  test('the rendered chat tree shows the arithmetic and dunders intact', () => {
    expect(renderedStrings(render(MIXED)).join('')).toBe(
      'Compute 2 * 3 * 4, keep __init__.py and __name__, but emphasise this and bold this text.',
    );
  });

  test('a mixed line in a list item is preserved too', () => {
    const [block] = parseMarkdown('- 2 * 3 * 4 = 24 and __init__.py');
    expect(block).toMatchObject({ type: 'list', ordered: false });
    if (block?.type !== 'list') throw new Error('expected a list');
    expect(visible(block.items[0])).toBe('2 * 3 * 4 = 24 and __init__.py');
  });
});
