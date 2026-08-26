import {
  markdownBlocksForDisplay,
  parseInline,
  parseMarkdown,
} from '@/components/chat/markdown/parser';

const SAMPLE_LINE = '- **bold** `code` [docs](https://expo.dev) *italic*\n';

function parseMs(text: string): number {
  const start = performance.now();
  parseMarkdown(text);
  return performance.now() - start;
}

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

  test('parseMarkdown takes longer as the reply grows', () => {
    const short = SAMPLE_LINE.repeat(8);
    const long = SAMPLE_LINE.repeat(400);
    parseMarkdown(short);
    parseMarkdown(long);

    let shortTotal = 0;
    let longTotal = 0;
    for (let i = 0; i < 12; i += 1) {
      shortTotal += parseMs(short);
      longTotal += parseMs(long);
    }

    expect(long.length).toBeGreaterThan(short.length * 20);
    expect(longTotal).toBeGreaterThan(shortTotal);
  });

  test('a streaming body skips the full parse', () => {
    const text = '# Title\n\n- **one**\n- two\n\n```ts\nconst x = 1;\n``` ▍';
    expect(markdownBlocksForDisplay(text, true)).toEqual([
      { type: 'paragraph', spans: [{ text }] },
    ]);
  });

  test('a completed body still parses markdown', () => {
    const text = '# Title\n\n- one\n- two';
    const blocks = markdownBlocksForDisplay(text, false);
    expect(blocks.map((block) => block.type)).toEqual(['heading', 'list']);
    expect(markdownBlocksForDisplay(text)).toEqual(blocks);
  });
});

