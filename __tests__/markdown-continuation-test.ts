import { markdownBlocksForDisplay, parseMarkdown } from '@/components/chat/markdown/parser';

/**
 * Regression coverage for the streaming-markdown cost bug.
 *
 * A streamed turn used to re-run the full block parser on every chunk, so the
 * per-chunk cost grew with the whole accumulated buffer (quadratic over the
 * turn). Commit 162645b fixed it: while `streaming` is true,
 * `markdownBlocksForDisplay` returns ONE plain paragraph and never calls the
 * structural parser. These tests lock that behavior so it cannot quietly
 * regress to a per-chunk full parse.
 *
 * NOTE: the original item proposed a continuation helper (`continueMarkdownBlocks`)
 * that would keep parsing the tail of an append-only buffer. The shipped fix is
 * simpler and cheaper — render the in-flight body as plain text and only parse
 * it into real blocks once the stream completes. We test the shipped behavior.
 */

const BIG_MARKDOWN =
  '# Heading\n\n' +
  '- **bold** `code` [docs](https://expo.dev) *italic*\n'.repeat(800) +
  '\n```ts\nconst x = 1;\n```';

function streamMs(text: string): number {
  const start = performance.now();
  markdownBlocksForDisplay(text, true);
  return performance.now() - start;
}

describe('streaming markdown does not re-parse the whole buffer', () => {
  test('a streaming body is a single plain paragraph, not structural blocks', () => {
    const text =
      '# Title\n\n- **one**\n- two\n\n```ts\nconst x = 1;\n``` ▍';
    const blocks = markdownBlocksForDisplay(text, true);
    expect(blocks).toEqual([{ type: 'paragraph', spans: [{ text }] }]);
    expect(blocks.length).toBe(1);
    // No heading / list / code block was produced while streaming.
    expect(blocks.some((b) => b.type !== 'paragraph')).toBe(false);
  });

  test('a fence opened mid-stream renders as plain text, then parses on completion', () => {
    const openFence = 'look:\n```ts\nconst a = 1;\n'; // fence opened, never closed
    const streaming = markdownBlocksForDisplay(openFence, true);
    expect(streaming).toEqual([{ type: 'paragraph', spans: [{ text: openFence }] }]);

    // Once the stream completes the same text is parsed into real blocks.
    const done = markdownBlocksForDisplay(openFence, false);
    expect(done.map((b) => b.type)).toEqual(['paragraph', 'code']);
  });

  test('the non-streaming branch always parses the full structure', () => {
    const text = '# Title\n\n- one\n- two\n\n```ts\nconst x = 1;\n```';
    const blocks = markdownBlocksForDisplay(text, false);
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'list', 'code']);
    expect(markdownBlocksForDisplay(text)).toEqual(blocks); // default = not streaming
  });

  test('streaming a large body is far cheaper than parsing it', () => {
    const long = BIG_MARKDOWN; // ~50k chars of real markdown
    const streamMs = (() => {
      const start = performance.now();
      markdownBlocksForDisplay(long, true);
      return performance.now() - start;
    })();
    const parseMs = (() => {
      const start = performance.now();
      markdownBlocksForDisplay(long, false);
      return performance.now() - start;
    })();
    // The streaming branch only wraps the text in one plain span; it must not
    // pay the cost of the structural parse the full body would trigger.
    expect(streamMs).toBeLessThan(parseMs * 0.25);
  });

  test('parseMarkdown on a large body is still exercised when not streaming', () => {
    // Sanity: the real parser still handles big input so the streaming plain-text
    // shortcut does not hide a broken parser behind it.
    const blocks = parseMarkdown(BIG_MARKDOWN);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.some((b) => b.type === 'code')).toBe(true);
  });
});
