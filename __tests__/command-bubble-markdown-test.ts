declare const __dirname: string;

import { markdownBlocksForDisplay } from '@/components/chat/markdown/parser';

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('command bubble markdown', () => {
  test('MarkdownText is imported from the chat markdown renderer', () => {
    const src = readSource(['src', 'components', 'chat', 'message-bubble.tsx']);
    expect(src).toMatch(
      /import \{ MarkdownText \} from '@\/components\/chat\/markdown\/markdown-text';/,
    );
  });

  test('the command branch renders the body through compact MarkdownText, not a plain caption Text', () => {
    const src = readSource(['src', 'components', 'chat', 'message-bubble.tsx']);
    const start = src.indexOf('{isCommand ? (');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf(') : isUser ? (', start);
    expect(end).toBeGreaterThan(start);
    const commandBranch = src.slice(start, end);
    expect(commandBranch).toMatch(
      /<MarkdownText text=\{body\} compact streaming=\{!!message\.streaming\} \/>/,
    );
    expect(commandBranch).not.toMatch(/<Text color="primary" variant="caption">/);
  });

  test('the user branch keeps its plain Text — operator input is not parsed', () => {
    const src = readSource(['src', 'components', 'chat', 'message-bubble.tsx']);
    const start = src.indexOf(') : isUser ? (');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf(') : (', start);
    expect(end).toBeGreaterThan(start);
    const userBranch = src.slice(start, end);
    expect(userBranch).toMatch(/<Text color="primary" variant="body">\s*\{message\.text\}\s*<\/Text>/);
    expect(userBranch).not.toMatch(/MarkdownText/);
  });

  test('the assistant branch keeps its body-scale MarkdownText, untouched', () => {
    const src = readSource(['src', 'components', 'chat', 'message-bubble.tsx']);
    const start = src.indexOf(') : (', src.indexOf(') : isUser ? ('));
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('{isInterrupted && onResume', start);
    expect(end).toBeGreaterThan(start);
    const assistantBranch = src.slice(start, end);
    expect(assistantBranch).toMatch(
      /<MarkdownText text=\{body\} streaming=\{!!message\.streaming\} \/>/,
    );
    expect(assistantBranch).not.toMatch(/compact/);
  });

  test('MarkdownText declares a compact prop at caption scale (13/18, tokens.ts:101)', () => {
    const src = readSource(['src', 'components', 'chat', 'markdown', 'markdown-text.tsx']);
    expect(src).toMatch(/compact\?: boolean/);
    expect(src).toMatch(/bodyCompact: \{/);
    // caption metrics from src/constants/tokens.ts:101 -- fontSize 13 / lineHeight 18
    expect(src).toMatch(/fontSize: 13,/);
    expect(src).toMatch(/lineHeight: 18,/);
  });

  test('plain command text without markdown renders as one identical paragraph', () => {
    const plain = 'Available models: a, b, c';
    const blocks = markdownBlocksForDisplay(plain, false);
    expect(blocks).toEqual([{ type: 'paragraph', spans: [{ text: plain }] }]);
  });
});