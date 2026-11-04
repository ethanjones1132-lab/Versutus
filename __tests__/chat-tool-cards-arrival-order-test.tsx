declare const __dirname: string;

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { splitBodyAroundActivity } from '@/lib/chat/activity-anchor';
import { addStreamingPlaceholder } from '@/lib/gateway/message-reducer';
import { createStreamBatcher } from '@/lib/gateway/stream-batching';
import type { ChatMessage } from '@/lib/gateway/types';

/**
 * A fast turn must render in the order it happened.
 *
 * The bubble carries two kinds of content — the words (`text`) and one activity
 * block (thinking + tool cards). The block used to be painted above every word,
 * so a turn that wrote a sentence, called a tool, then answered showed the card
 * first and both sentences below it. The fix is a single recorded moment: the
 * text length at the instant the block first held anything. Everything before
 * it stays above the block, everything after stays below.
 *
 * These tests pin both halves of that: the reducer/batcher that records the
 * moment (a tool queued first anchors at 0, a tool queued after text anchors
 * after it — a batch used to apply text before tools regardless of arrival),
 * and the bubble that renders the split.
 */

jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: { View },
    Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
  };
});

jest.mock('@/lib/motion/presets', () => ({ entering: { rise: {} } }));
jest.mock('expo-image', () => ({ Image: 'Image' }));
jest.mock('@/components/chat/markdown/markdown-text', () => ({ MarkdownText: 'MarkdownText' }));
jest.mock('@/components/chat/streaming-indicator', () => ({ StreamingIndicator: 'StreamingIndicator' }));
jest.mock('@/components/chat/tool-call-card', () => ({ ToolCallCard: 'ToolCallCard' }));
jest.mock('@/components/ui', () => ({
  Badge: 'Badge',
  Icon: 'Icon',
  PressableScale: 'PressableScale',
  Text: 'Text',
}));
jest.mock('@/lib/haptics', () => ({
  haptics: { light: jest.fn(async () => undefined), medium: jest.fn(async () => undefined) },
}));

import { MessageBubble } from '@/components/chat/message-bubble';

const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};
const SEP = __dirname.includes('\\') ? '\\' : '/';

function readBubbleSource(): string {
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'components', 'chat', 'message-bubble.tsx'].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

type Harness = ReturnType<typeof makeHarness>;

function makeHarness() {
  let messages: ChatMessage[] = addStreamingPlaceholder([], 'run-1');
  const setMessages = (updater: (prev: ChatMessage[]) => ChatMessage[]) => {
    messages = updater(messages);
  };
  const batcher = createStreamBatcher({
    runId: 'run-1',
    setMessages,
    schedule: () => 1,
    cancel: () => undefined,
  });
  return {
    batcher,
    get message(): ChatMessage {
      return messages[0];
    },
  };
}

function flush(harness: Harness): ChatMessage {
  harness.batcher.flush();
  return harness.message;
}

describe('the activity block is anchored where it arrived', () => {
  test('text, then a tool call: the words stay above the block', () => {
    const h = makeHarness();
    h.batcher.queueDelta('Let me check.');
    h.batcher.queueTool({ name: 'shell', status: 'running' });
    h.batcher.queueDelta(' All good.');
    const message = flush(h);
    expect(message.activityAnchor).toBe('Let me check.'.length);
    expect(message.text).toBe('Let me check. All good.');
  });

  test('a tool call before any text anchors at the very start', () => {
    const h = makeHarness();
    // A batch carries the turn exactly as it arrived. The flush used to apply
    // text first no matter what, which put this text above a card the model had
    // already called before writing a word.
    h.batcher.queueTool({ name: 'shell', status: 'running' });
    h.batcher.queueDelta('All good.');
    const message = flush(h);
    expect(message.activityAnchor).toBe(0);
    expect(message.text).toBe('All good.');
  });

  test('thinking before the answer anchors at the start too', () => {
    const h = makeHarness();
    h.batcher.queueReasoning('Reading the logs.');
    h.batcher.queueDelta('The gateway is fine.');
    const message = flush(h);
    expect(message.activityAnchor).toBe(0);
  });

  test('the batch records the kinds in arrival order, not a fixed one', () => {
    const h = makeHarness();
    h.batcher.queueTool({ name: 'shell', status: 'running' });
    h.batcher.queueDelta('one');
    h.batcher.queueReasoning('think');
    h.batcher.queueTool({ name: 'read', status: 'running' });
    expect(h.batcher.pending.order).toEqual(['tool', 'text', 'reasoning', 'tool']);
  });

  test('a later tool call does not move the anchor', () => {
    const h = makeHarness();
    h.batcher.queueDelta('Checking.');
    h.batcher.queueTool({ name: 'shell', status: 'running' });
    flush(h);
    h.batcher.queueDelta(' More.');
    h.batcher.queueTool({ name: 'read', status: 'running' });
    const message = flush(h);
    expect(message.activityAnchor).toBe('Checking.'.length);
    expect(message.toolCalls).toHaveLength(2);
  });

  test('a history row carries no anchor, so the block stays above the answer', () => {
    const historyRow: ChatMessage = {
      id: 'h-1',
      role: 'assistant',
      text: 'Answer\nwith two lines',
      toolCalls: [{ name: 'shell', status: 'complete' }],
    };
    expect(splitBodyAroundActivity(historyRow.text, historyRow.activityAnchor)).toEqual({
      before: '',
      after: historyRow.text,
    });
  });
});

describe('splitBodyAroundActivity', () => {
  test('splits on the line boundary the anchor sits on', () => {
    const text = 'Let me check.\nAll good.';
    expect(splitBodyAroundActivity(text, 'Let me check.\n'.length)).toEqual({
      before: 'Let me check.\n',
      after: 'All good.',
    });
  });

  test('never cuts a line in two', () => {
    const text = 'Let me check. All good.';
    // The anchor is mid-line, so there is no honest place to put the block.
    expect(splitBodyAroundActivity(text, 'Let me check.'.length)).toEqual({
      before: '',
      after: text,
    });
  });

  test('never leaves a code fence open across the halves', () => {
    const text = '```\nconst a = 1;\nmore code\n```';
    const anchor = text.indexOf('more code');
    expect(splitBodyAroundActivity(text, anchor)).toEqual({ before: '', after: text });
  });

  test('an anchor at the start, past the end, or absent leaves the body whole', () => {
    const text = 'one\ntwo';
    for (const anchor of [undefined, 0, -5, text.length, text.length + 10, Number.NaN]) {
      expect(splitBodyAroundActivity(text, anchor)).toEqual({ before: '', after: text });
    }
    expect(splitBodyAroundActivity('', 4)).toEqual({ before: '', after: '' });
  });
});

type TestNode = {
  type: string;
  props: Record<string, unknown>;
  children: unknown[] | null;
};

function flatten(node: unknown, out: TestNode[] = []): TestNode[] {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  const typed = node as TestNode;
  if (typeof typed.type === 'string') out.push(typed);
  if (typed.children) flatten(typed.children, out);
  return out;
}

function render(message: ChatMessage): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(createElement(MessageBubble, { message }));
  });
  return renderer;
}

function activityLineAt(nodes: TestNode[]): number {
  return nodes.findIndex(
    (node) => node.type === 'PressableScale'
      && String(node.props.accessibilityLabel).startsWith('Used 1 tool'),
  );
}

describe('the bubble renders the words and the block in arrival order', () => {
  test('text written before the tool call renders above the activity line', () => {
    const before = 'Let me check.\n';
    const after = 'All good.';
    const renderer = render({
      id: 'run-1',
      role: 'assistant',
      text: `${before}${after}`,
      streaming: false,
      activityAnchor: before.length,
      reasoning: 'Reading the logs.',
      toolCalls: [{ name: 'shell', status: 'complete', detail: 'ok' }],
    });
    const nodes = flatten(renderer.toJSON());
    const markdown = nodes
      .map((node, index) => ({ node, index }))
      .filter((entry) => entry.node.type === 'MarkdownText');
    expect(markdown.map((entry) => entry.node.props.text)).toEqual([before, after]);

    const activityAt = activityLineAt(nodes);
    expect(activityAt).toBeGreaterThan(-1);
    expect(activityAt).toBeGreaterThan(markdown[0].index);
    expect(activityAt).toBeLessThan(markdown[1].index);
  });

  test('a reply with no anchor keeps its whole body below the activity line', () => {
    const renderer = render({
      id: 'h-1',
      role: 'assistant',
      text: 'The whole answer.',
      streaming: false,
      toolCalls: [{ name: 'shell', status: 'complete' }],
    });
    const nodes = flatten(renderer.toJSON());
    const markdown = nodes
      .map((node, index) => ({ node, index }))
      .filter((entry) => entry.node.type === 'MarkdownText');
    expect(markdown.map((entry) => entry.node.props.text)).toEqual(['The whole answer.']);
    const activityAt = activityLineAt(nodes);
    expect(activityAt).toBeGreaterThan(-1);
    expect(markdown[0].index).toBeGreaterThan(activityAt);
  });
});

describe('the bubble source wires the split', () => {
  test('the split helper is imported and drives body and bodyBefore', () => {
    const src = readBubbleSource();
    expect(src).toMatch(/import \{ splitBodyAroundActivity \} from '@\/lib\/chat\/activity-anchor';/);
  });

  test('the before-part renders above the activity block and the body below it', () => {
    const src = readBubbleSource();
    const beforeAt = src.indexOf('text={bodyBefore}');
    const activityAt = src.indexOf('{!isUser && hasActivity ? (');
    const bodyAt = src.indexOf('text={body} streaming={!!message.streaming}');
    expect(beforeAt).toBeGreaterThan(-1);
    expect(activityAt).toBeGreaterThan(beforeAt);
    expect(bodyAt).toBeGreaterThan(activityAt);
  });
});

describe('review fix: a batch applies each run of words once, in place', () => {
  test('text, tool, text, tool in one frame: no sentence is applied twice and each tool keeps its place', () => {
    const h = makeHarness();
    h.batcher.queueDelta('One.');
    h.batcher.queueTool({ id: 'a', name: 'shell', status: 'running' });
    h.batcher.queueTool({ id: 'b', name: 'read', status: 'running' });
    h.batcher.queueDelta(' Two.');
    const message = flush(h);
    expect(message.text).toBe('One. Two.');
    expect(message.activityAnchor).toBe('One.'.length);
    expect(message.toolCalls?.map((call) => call.id)).toEqual(['a', 'b']);
  });

  test('reasoning, text, reasoning in one frame: each thought is applied once', () => {
    const h = makeHarness();
    h.batcher.queueReasoning('Think A.');
    h.batcher.queueDelta('Answer.');
    h.batcher.queueReasoning(' Think B.');
    const message = flush(h);
    expect(message.reasoning).toBe('Think A. Think B.');
    expect(message.text).toBe('Answer.');
  });
});
