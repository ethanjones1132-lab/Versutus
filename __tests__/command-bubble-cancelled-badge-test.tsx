/**
 * A cancelled command must not wear the success-toned "Done" badge.
 *
 * `cancelCommand` records `cancelled` in the transcript and deliberately
 * clears the bubble's own status, because the bubble vocabulary has no
 * cancelled state. The header badge then defaulted the missing status to
 * `complete`, so the one command the operator stopped showed a green Done.
 *
 * These tests render the real MessageBubble and read the Badge it emits, so a
 * mapping-only fix cannot pass while the call site still defaults to Done.
 */

// Reanimated only carries the native entering animation here.
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

// Heavy children this test does not exercise: the badge is what it reads.
jest.mock('@/components/chat/markdown/markdown-text', () => ({ MarkdownText: 'MarkdownText' }));
jest.mock('@/components/chat/streaming-indicator', () => ({ StreamingIndicator: 'StreamingIndicator' }));
jest.mock('@/components/chat/tool-call-card', () => ({ ToolCallCard: 'ToolCallCard' }));

// The kit barrel reaches native primitives; the badge's label and tone are the
// contract here, so each primitive renders as a named host element.
jest.mock('@/components/ui', () => ({
  Badge: 'Badge',
  Icon: 'Icon',
  PressableScale: 'PressableScale',
  Text: 'Text',
}));

jest.mock('@/lib/haptics', () => ({
  haptics: { light: jest.fn(async () => undefined), medium: jest.fn(async () => undefined) },
}));

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { MessageBubble } from '@/components/chat/message-bubble';
import type { ChatMessage } from '@/lib/gateway/types';

function render(message: ChatMessage): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(createElement(MessageBubble, { message }));
  });
  return renderer;
}

function commandMessage(status: 'running' | 'complete' | 'error' | undefined): ChatMessage {
  return {
    id: 'cmd-1',
    role: 'assistant',
    text: 'Command output',
    command: { input: '/status', title: '/status', status, ephemeral: true },
  };
}

/** The single status badge in the command header, as label + tone. */
function statusBadge(renderer: ReactTestRenderer): { label: string; tone: string } {
  const badges = renderer.root.findAll((node) => (node.type as unknown) === 'Badge');
  expect(badges).toHaveLength(1);
  return { label: badges[0].props.label, tone: badges[0].props.tone };
}

describe('command bubble status badge', () => {
  test('a cancelled command (cleared status) reads a neutral Stopped', () => {
    const renderer = render(commandMessage(undefined));
    expect(statusBadge(renderer)).toEqual({ label: 'Stopped', tone: 'neutral' });
    // The stop must not read as work in flight or as a failure either.
    expect(renderer.root.findAll((node) => (node.type as unknown) === 'Badge')).toHaveLength(1);
  });

  test('a completed command still reads a success Done', () => {
    expect(statusBadge(render(commandMessage('complete')))).toEqual({
      label: 'Done',
      tone: 'success',
    });
  });

  test('a failed command keeps its danger Failed', () => {
    expect(statusBadge(render(commandMessage('error')))).toEqual({
      label: 'Failed',
      tone: 'danger',
    });
  });

  test('a running command keeps its warning Running', () => {
    expect(statusBadge(render(commandMessage('running')))).toEqual({
      label: 'Running',
      tone: 'warning',
    });
  });

  test('a non-command message renders no status badge at all', () => {
    const renderer = render({ id: 'reply-1', role: 'assistant', text: 'Hi' });
    expect(renderer.root.findAll((node) => (node.type as unknown) === 'Badge')).toHaveLength(0);
  });
});
