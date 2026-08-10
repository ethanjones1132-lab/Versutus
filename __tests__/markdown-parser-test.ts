import { parseInline, parseMarkdown } from '@/components/chat/markdown/parser';

describe('markdown parser', () => {
  test('parses inline emphasis, code, and links', () => {
    expect(parseInline('a **bold** and `code`')).toEqual([
      { text: 'a ' },
      { text: 'bold', bold: true },
      { text: ' and ' },
      { text: 'code', code: true },
    ]);
    expect(parseInline('[docs](https://expo.dev)')).toEqual([
      { text: 'docs', link: 'https://expo.dev' },
    ]);
  });

  test('does not treat snake_case as emphasis', () => {
    expect(parseInline('some_snake_case')).toEqual([{ text: 'some_snake_case' }]);
  });

  test('builds block structure for agent output', () => {
    const blocks = parseMarkdown('# Title\n\n- one\n- two\n\n```ts\nconst x = 1;\n```');
    expect(blocks.map((block) => block.type)).toEqual(['heading', 'list', 'code']);
    expect(blocks[1]).toMatchObject({ type: 'list', ordered: false });
    expect(blocks[2]).toMatchObject({ type: 'code', language: 'ts', code: 'const x = 1;' });
  });
});
