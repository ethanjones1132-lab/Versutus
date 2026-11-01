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

  test('keeps the number an ordered list starts at, including zero', () => {
    expect(parseMarkdown('3. third\n4. fourth')[0]).toEqual({
      type: 'list',
      ordered: true,
      start: 3,
      items: [[{ text: 'third' }], [{ text: 'fourth' }]],
    });
    expect(parseMarkdown('0. zero\n1. one')[0]).toMatchObject({
      type: 'list',
      ordered: true,
      start: 0,
    });
  });

  test('a list resumed after a paragraph keeps its own first number', () => {
    const blocks = parseMarkdown('Setup notes.\n\n3. third\n4. fourth');
    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'list']);
    expect(blocks[1]).toMatchObject({ type: 'list', ordered: true, start: 3 });
  });

  test('a list resumed after a code block keeps its own first number', () => {
    const blocks = parseMarkdown('1. one\n2. two\n\n```sh\nrun\n```\n\n3. three\n4. four');
    expect(blocks.map((block) => block.type)).toEqual(['list', 'code', 'list']);
    expect(blocks[0]).toMatchObject({ type: 'list', ordered: true, start: 1 });
    expect(blocks[2]).toMatchObject({ type: 'list', ordered: true, start: 3 });
  });

  test('ordinary ordered lists start at 1 and unordered lists carry no start', () => {
    expect(parseMarkdown('1. one\n2. two')[0]).toMatchObject({ ordered: true, start: 1 });
    const unordered = parseMarkdown('- one\n- two')[0];
    expect(unordered).toMatchObject({ type: 'list', ordered: false });
    expect(unordered).not.toHaveProperty('start');
  });

  test('a closer must be at least as long as the fence it closes', () => {
    // A four-backtick fence can wrap a three-backtick block; the short run
    // inside is content, not the end of the block.
    const text = '````md\n```ts\nconst x = 1;\n```\n````';
    expect(parseMarkdown(text)).toEqual([
      { type: 'code', language: 'md', code: '```ts\nconst x = 1;\n```' },
    ]);
  });

  test('a closer may be longer than the fence it closes', () => {
    expect(parseMarkdown('```ts\nconst x = 1;\n````')).toEqual([
      { type: 'code', language: 'ts', code: 'const x = 1;' },
    ]);
  });

  test('a fence run followed by text inside a block stays content', () => {
    // Pre-fix the ` ```ts ` line closed the block opened by the bare ` ``` `
    // line, so the code escaped and the remainder fell back to prose.
    expect(parseMarkdown('```\n```ts\nconst x = 1;\n```')).toEqual([
      { type: 'code', code: '```ts\nconst x = 1;' },
    ]);
  });

  test('a truncated long fence loses no text and renders no empty code block', () => {
    // The outer four-backtick fence never closes. Its marker line must stay
    // visible as prose, and the short inner pair is a legitimate (terminated)
    // block, so the body renders as text + code with nothing swallowed.
    const text = '````md\n```ts\nconst x = 1;\n```';
    const blocks = parseMarkdown(text);
    expect(blocks.some((block) => block.type === 'code' && block.code === '')).toBe(false);
    expect(blocks[0]).toMatchObject({ type: 'paragraph' });
    const visible = blocks
      .flatMap((block) => {
        if (block.type === 'code') return [block.code];
        if (block.type === 'paragraph') return block.spans.map((span) => span.text);
        return [];
      })
      .join('\n');
    expect(visible).toContain('````md');
    expect(visible).toContain('const x = 1;');
  });

  test('tilde fences follow the same rule and tolerate indentation or trailing spaces', () => {
    expect(parseMarkdown('~~~\n```\n~~~')).toEqual([{ type: 'code', code: '```' }]);
    expect(parseMarkdown('  ```\ncode\n  ```   ')).toEqual([{ type: 'code', code: 'code' }]);
  });

  test('an unordered run and an ordered run are separate lists', () => {
    // Pre-fix one list block swallowed both runs, so the ordered lines were
    // drawn as bullets (or, in the reverse order, bullets were numbered).
    const bulletsThenNumbers = parseMarkdown('- bullet\n1. first\n2. second');
    expect(bulletsThenNumbers).toEqual([
      { type: 'list', ordered: false, items: [[{ text: 'bullet' }]] },
      {
        type: 'list',
        ordered: true,
        start: 1,
        items: [[{ text: 'first' }], [{ text: 'second' }]],
      },
    ]);

    const numbersThenBullets = parseMarkdown('1. first\n- bullet\n- another');
    expect(numbersThenBullets).toEqual([
      { type: 'list', ordered: true, start: 1, items: [[{ text: 'first' }]] },
      {
        type: 'list',
        ordered: false,
        items: [[{ text: 'bullet' }], [{ text: 'another' }]],
      },
    ]);
  });

  test('the ordered run after an unordered one keeps its written number', () => {
    const blocks = parseMarkdown('- bullet\n4. fourth\n5. fifth');
    expect(blocks[1]).toMatchObject({ type: 'list', ordered: true, start: 4 });
    expect(blocks[1]).toMatchObject({
      items: [[{ text: 'fourth' }], [{ text: 'fifth' }]],
    });
  });

  test('different unordered markers stay one list', () => {
    // The renderer draws the same dot for every marker, so mixing them must not
    // split the list (the delimiter is not visible to the reader).
    expect(parseMarkdown('- a\n* b\n+ c')[0]).toEqual({
      type: 'list',
      ordered: false,
      items: [[{ text: 'a' }], [{ text: 'b' }], [{ text: 'c' }]],
    });
  });

  test('indented sub-items stay flat: the renderer has no nesting', () => {
    // Documented limitation, not a claimed feature: indentation is ignored and
    // every item renders at one level, so a sub-item reads as a sibling.
    expect(parseMarkdown('- a\n  - b')[0]).toEqual({
      type: 'list',
      ordered: false,
      items: [[{ text: 'a' }], [{ text: 'b' }]],
    });
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

