import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { NewRoutineSheet } from '@/components/routines/new-routine-sheet';
import type { RoutineTarget } from '@/components/routines/new-routine-sheet';

jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

jest.mock('@/components/ui', () => ({
  BaseSheet: 'BaseSheet',
  Button: 'Button',
  Chip: 'Chip',
  ListRow: 'ListRow',
  Text: 'Text',
  TextField: 'TextField',
}));

jest.mock('@/components/routines/schedule-picker', () => ({ SchedulePicker: 'SchedulePicker' }));

const target: RoutineTarget = {
  key: 'backend:codex',
  label: 'Codex',
  kind: 'Backend',
  scope: { backendId: 'codex', botId: null },
};

test('a refused Gate create shows its error and keeps the typed fields and cron for retry', async () => {
  let renderer: ReactTestRenderer | undefined;
  const onCreate = jest.fn().mockRejectedValue(new Error('Gate refused create'));
  try {
    act(() => {
      renderer = create(
        <NewRoutineSheet
          visible
          targets={[target]}
          onClose={jest.fn()}
          onCreate={onCreate}
        />,
      );
    });

    const title = renderer!.root.findAllByType('TextField' as never)
      .find((node) => (node.props as { accessibilityLabel?: string }).accessibilityLabel === 'Routine name');
    const prompt = renderer!.root.findAllByType('TextField' as never)
      .find((node) => (node.props as { accessibilityLabel?: string }).accessibilityLabel === 'Routine prompt');
    expect(title).toBeDefined();
    expect(prompt).toBeDefined();
    act(() => {
      (title!.props as { onChangeText: (value: string) => void }).onChangeText('Morning review');
      (prompt!.props as { onChangeText: (value: string) => void }).onChangeText('Check the queue');
    });

    const save = renderer!.root.findAllByType('Button' as never)
      .find((node) => (node.props as { label?: string }).label === 'Save routine');
    expect(save).toBeDefined();
    await act(async () => {
      (save!.props as { onPress: () => void }).onPress();
      await Promise.resolve();
    });

    expect(onCreate).toHaveBeenCalledWith(
      { title: 'Morning review', prompt: 'Check the queue', schedule: '0 9 * * *' },
      { backendId: 'codex', botId: null },
    );
    const fields = renderer!.root.findAllByType('TextField' as never);
    expect(fields.map((field) => (field.props as { value: string }).value)).toEqual([
      'Morning review',
      'Check the queue',
    ]);
    expect(renderer!.root.findAllByType('Text' as never)
      .some((node) => (node.props as { children?: unknown }).children === 'Gate refused create')).toBe(true);
  } finally {
    act(() => renderer?.unmount());
  }
});

test('the backend chip filter takes precedence over a Bot selected on another backend', () => {
  let renderer: ReactTestRenderer | undefined;
  const filteredBackend: RoutineTarget = {
    key: 'backend:opencode',
    label: 'OpenCode',
    kind: 'Backend',
    scope: { backendId: 'opencode', botId: null },
  };
  const botTarget: RoutineTarget = {
    key: 'bot:codex:writer',
    label: 'Writer',
    kind: 'Bot',
    scope: { backendId: 'codex', botId: 'writer' },
  };
  try {
    act(() => {
      renderer = create(
        <NewRoutineSheet
          visible
          targets={[botTarget, target, filteredBackend]}
          initialBackendId="opencode"
          initialBotId="writer"
          onClose={jest.fn()}
          onCreate={jest.fn()}
        />,
      );
    });
    const chips = renderer!.root.findAllByType('Chip' as never);
    expect(chips.find((chip) => (chip.props as { label: string }).label === 'Writer')?.props.selected).toBe(false);
    expect(chips.find((chip) => (chip.props as { label: string }).label === 'OpenCode')?.props.selected).toBe(true);
  } finally {
    act(() => renderer?.unmount());
  }
});
