// The compare view is drawn for real below: its kit is mocked to plain host
// components so the test reads the columns the operator actually gets, and
// reanimated's native worklets stay out of jest (tokens.ts only needs Easing).
jest.mock('@/components/ui', () => ({
  Card: 'Card',
  ErrorCard: 'ErrorCard',
  PressableScale: 'PressableScale',
  Text: 'Text',
}));
jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { CouncilCompareView } from '@/components/chat/council-compare-view';
import type { CouncilColumn } from '@/lib/gateway/council';

// Drawn, not read: one Bot failing is that Bot's column. These assertions press
// and inspect the rendered columns, so deleting the failed-column branch (or
// letting a failure collapse into the summary) makes them fail rather than
// merely diverge from a source string.
describe('a failed Bot is drawn as its own column, in roster order', () => {
  const ERROR_CARD = 'ErrorCard' as ElementType;
  const PRESSABLE = 'PressableScale' as ElementType;
  const TEXT = 'Text' as ElementType;

  const mixedColumns: CouncilColumn[] = [
    { botId: 'scout', label: 'Scout', state: 'answered', text: 'Scout read the notes.' },
    {
      botId: 'night',
      label: 'Night',
      state: 'failed',
      error: 'Request timed out: POST /v1/bot-groups/room-1',
    },
    { botId: 'ada', label: 'ada', state: 'answered', text: 'ada read the notes.' },
  ];

  const allFailedColumns: CouncilColumn[] = [
    { botId: 'scout', label: 'Scout', state: 'failed', error: 'Scout did not answer' },
    { botId: 'night', label: 'Night', state: 'failed', error: 'Night is out of credits' },
    { botId: 'ada', label: 'ada', state: 'failed', error: 'ada is unreachable' },
  ];

  async function draw(
    columns: CouncilColumn[],
    onPressColumn: (column: CouncilColumn) => void = jest.fn(),
  ): Promise<ReactTestRenderer> {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(CouncilCompareView, { columns, onPressColumn }));
    });
    return renderer;
  }

  /** The column wrappers in draw order, each labelled with its Bot and state. */
  function columnsDrawn(renderer: ReactTestRenderer): ReactTestInstance[] {
    // React Native View has a composite wrapper and a host child with the same label.
    return renderer.root.findAll(
      (node) => typeof node.type === 'string' && typeof node.props.accessibilityLabel === 'string',
    );
  }

  function errorCards(renderer: ReactTestRenderer): ReactTestInstance[] {
    return renderer.root.findAll((node) => node.type === ERROR_CARD);
  }

  function texts(renderer: ReactTestRenderer): string[] {
    return renderer.root
      .findAll((node) => node.type === TEXT)
      .map((node) => node.props.children)
      .filter((child): child is string => typeof child === 'string');
  }

  test('the failed Bot stays between the answers and names its own error', async () => {
    const renderer = await draw(mixedColumns);

    expect(columnsDrawn(renderer).map((node) => node.props.accessibilityLabel)).toEqual([
      'Scout, answered',
      'Night, failed',
      'ada, answered',
    ]);
    const failures = errorCards(renderer);
    expect(failures).toHaveLength(1);
    expect(failures[0].props.cause).toBe('Request timed out: POST /v1/bot-groups/room-1');
    expect(failures[0].props.affected).toBe("Night's answer");
    // Every Bot still owns a named column with its own content.
    expect(texts(renderer)).toEqual(expect.arrayContaining(['Scout', 'Night', 'ada']));
    // The summary counts the failure honestly instead of hiding it.
    expect(texts(renderer)).toContain('2 of 3 answered.');
  });

  test('the failed column is not pressable while the answered columns still open', async () => {
    const onPressColumn = jest.fn();
    const renderer = await draw(mixedColumns, onPressColumn);

    const pressables = renderer.root.findAll((node) => node.type === PRESSABLE);
    expect(pressables).toHaveLength(2);
    expect(pressables.map((node) => node.props.accessibilityRole)).toEqual(['button', 'button']);

    const night = columnsDrawn(renderer).find(
      (node) => node.props.accessibilityLabel === 'Night, failed',
    ) as ReactTestInstance;
    expect(night.type).not.toBe(PRESSABLE);
    expect(night.props.onPress).toBeUndefined();

    await act(async () => {
      for (const node of pressables) node.props.onPress();
    });
    expect(onPressColumn.mock.calls.map(([column]) => column.botId)).toEqual(['scout', 'ada']);
  });

  test('an all-failed round keeps every column and names every error', async () => {
    const renderer = await draw(allFailedColumns);

    expect(columnsDrawn(renderer).map((node) => node.props.accessibilityLabel)).toEqual([
      'Scout, failed',
      'Night, failed',
      'ada, failed',
    ]);
    expect(errorCards(renderer).map((node) => node.props.cause)).toEqual([
      'Scout did not answer',
      'Night is out of credits',
      'ada is unreachable',
    ]);
    expect(renderer.root.findAll((node) => node.type === PRESSABLE)).toHaveLength(0);
    expect(texts(renderer)).toContain('0 of 3 answered.');
  });
});

