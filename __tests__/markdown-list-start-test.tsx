/**
 * VS-004: an ordered list keeps the numbers the model wrote.
 *
 * The parser used to drop the first marker and the renderer always printed
 * `index + 1`, so a reply like "1. ... 2. ... [code] 3. ... 4. ..." showed the
 * second list as 1/2. These tests render MarkdownText for real, not just the
 * parser's block shape, so a parser-only fix cannot pass while labels restart
 * at 1.
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

// A fence is part of the regression input; the code block's own chrome is not.
jest.mock('@/components/chat/markdown/code-block', () => ({ CodeBlock: 'CodeBlock' }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { MarkdownText } from '@/components/chat/markdown/markdown-text';
import type { MdBlock } from '@/components/chat/markdown/parser';

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

/** The ordered-list labels exactly as they reach the rendered output. */
function labels(renderer: ReactTestRenderer): string[] {
  return renderedStrings(renderer).filter((text) => /^\d+\.$/.test(text));
}

describe('MarkdownText renders the ordered-list numbers the model wrote', () => {
  test('a list beginning at 3 renders 3. and 4.', () => {
    expect(labels(render('3. third\n4. fourth'))).toEqual(['3.', '4.']);
  });

  test('a list beginning at 0 renders 0. and 1.', () => {
    expect(labels(render('0. zero\n1. one'))).toEqual(['0.', '1.']);
  });

  test('a list resumed after a paragraph continues from its written number', () => {
    expect(labels(render('Setup notes.\n\n3. third\n4. fourth'))).toEqual(['3.', '4.']);
  });

  test('a list resumed after a code block continues from its written number', () => {
    const text = '1. one\n2. two\n\n```sh\nrun\n```\n\n3. three\n4. four';
    expect(labels(render(text))).toEqual(['1.', '2.', '3.', '4.']);
  });

  test('ordinary lists still render from 1', () => {
    expect(labels(render('1. one\n2. two'))).toEqual(['1.', '2.']);
  });

  test('unordered lists render drawn dots, not numbers', () => {
    expect(labels(render('- one\n- two'))).toEqual([]);
  });
});

describe('the default for a list block built without a start', () => {
  // No public prop can inject a raw block, so this pins the fallback for
  // hand-built blocks: an absent start means 1, never 0. The constant also
  // proves the new field is optional, so pre-existing block literals still
  // type-check.
  const HAND_MADE: MdBlock = { type: 'list', ordered: true, items: [[{ text: 'one' }]] };
  const SOURCE = readFileSync(
    join(__dirname, '..', 'src', 'components', 'chat', 'markdown', 'markdown-text.tsx'),
    'utf8',
  );

  test('an absent start is treated as 1, not 0', () => {
    expect(HAND_MADE.start).toBeUndefined();
    expect(SOURCE).toContain('block.start ?? 1');
  });
});
