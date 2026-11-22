import React from 'react';
import { BackHandler } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { NewRoutineSheet } from '@/components/routines/new-routine-sheet';
import type { RoutineTarget } from '@/components/routines/new-routine-sheet';
import type { PublicBot } from '@/lib/gateway/bots';

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

type BackListener = () => boolean | null | undefined;

/** Capture the sheet's hardware Back subscription the way Android would call it. */
function captureAndroidBack() {
  let listener: BackListener | undefined;
  const remove = jest.fn();
  const spy = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_eventName, handler) => {
    listener = handler as unknown as BackListener;
    return { remove };
  });
  return {
    listener: () => listener,
    restore: () => spy.mockRestore(),
  };
}

function textField(renderer: ReactTestRenderer, accessibilityLabel: string) {
  const field = renderer.root.findAllByType('TextField' as never)
    .find((node) => (node.props as { accessibilityLabel?: string }).accessibilityLabel === accessibilityLabel);
  expect(field).toBeDefined();
  return field!;
}

function textValues(renderer: ReactTestRenderer): unknown[] {
  return renderer.root.findAllByType('Text' as never)
    .map((node) => (node.props as { children?: unknown }).children);
}

test('Android Back on a dirty draft preserves the typed draft instead of discarding it', () => {
  const onClose = jest.fn();
  const back = captureAndroidBack();
  let renderer: ReactTestRenderer | undefined;
  try {
    act(() => {
      renderer = create(
        <NewRoutineSheet visible targets={[target]} onClose={onClose} onCreate={jest.fn()} />,
      );
    });
    act(() => {
      (textField(renderer!, 'Routine name').props as { onChangeText: (value: string) => void })
        .onChangeText('Morning review');
    });

    const listener = back.listener();
    expect(listener).toBeDefined();
    let handled: unknown;
    act(() => { handled = listener!(); });

    // VS-137 takes the preserve option, not a discard prompt: Back closes the
    // sheet (the parent keeps this component mounted) and the typed draft is
    // still there when the sheet is shown again. One Back never loses the work.
    expect(handled).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(textValues(renderer!)).not.toContain('Discard this routine?');

    act(() => {
      renderer!.update(
        <NewRoutineSheet visible={false} targets={[target]} onClose={onClose} onCreate={jest.fn()} />,
      );
    });
    act(() => {
      renderer!.update(
        <NewRoutineSheet visible targets={[target]} onClose={onClose} onCreate={jest.fn()} />,
      );
    });
    expect((textField(renderer!, 'Routine name').props as { value: string }).value).toBe('Morning review');
  } finally {
    act(() => renderer?.unmount());
    back.restore();
  }
});

test('Android Back on a clean sheet closes it', () => {
  const onClose = jest.fn();
  const back = captureAndroidBack();
  let renderer: ReactTestRenderer | undefined;
  try {
    act(() => {
      renderer = create(
        <NewRoutineSheet visible targets={[target]} onClose={onClose} onCreate={jest.fn()} />,
      );
    });

    const listener = back.listener();
    expect(listener).toBeDefined();
    let handled: unknown;
    act(() => { handled = listener!(); });

    expect(handled).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(textValues(renderer!)).not.toContain('Discard this routine?');
  } finally {
    act(() => renderer?.unmount());
    back.restore();
  }
});

test('an unset-up Bot is not offered, while ready Bots and Backends stay', () => {
  const readyBot: RoutineTarget = {
    key: 'bot:codex:ready',
    label: 'Ready',
    kind: 'Bot',
    scope: { backendId: 'codex', botId: 'ready' },
  };
  const unsetBot: RoutineTarget = {
    key: 'bot:codex:idle',
    label: 'Idle',
    kind: 'Bot',
    scope: { backendId: 'codex', botId: 'idle' },
  };
  const bots: PublicBot[] = [
    { id: 'ready', displayName: 'Ready', routable: true },
    { id: 'idle', displayName: 'Idle', routable: false, routingIssue: 'listen_key_missing' },
  ];
  let renderer: ReactTestRenderer | undefined;
  try {
    act(() => {
      renderer = create(
        <NewRoutineSheet visible targets={[unsetBot, readyBot, target]} bots={bots} onClose={jest.fn()} onCreate={jest.fn()} />,
      );
    });
    const labels = renderer!.root.findAllByType('Chip' as never)
      .map((chip) => (chip.props as { label: string }).label);

    expect(labels).toContain('Ready');
    expect(labels).toContain('Codex');
    expect(labels).not.toContain('Idle');
    expect(textValues(renderer!)).toContain('1 Bot not set up');
  } finally {
    act(() => renderer?.unmount());
  }
});

test('when every Bot is unset up, a Backend target is still offered', () => {
  const unsetTargets: RoutineTarget[] = [
    { key: 'bot:codex:idle', label: 'Idle', kind: 'Bot', scope: { backendId: 'codex', botId: 'idle' } },
    { key: 'bot:codex:silent', label: 'Silent', kind: 'Bot', scope: { backendId: 'codex', botId: 'silent' } },
  ];
  const bots: PublicBot[] = [
    { id: 'idle', displayName: 'Idle', routable: false, routingIssue: 'listen_key_missing' },
    { id: 'silent', displayName: 'Silent', routable: false },
  ];
  let renderer: ReactTestRenderer | undefined;
  try {
    act(() => {
      renderer = create(
        <NewRoutineSheet visible targets={[...unsetTargets, target]} bots={bots} onClose={jest.fn()} onCreate={jest.fn()} />,
      );
    });
    const labels = renderer!.root.findAllByType('Chip' as never)
      .map((chip) => (chip.props as { label: string }).label);
    const texts = textValues(renderer!);

    expect(labels).toEqual(['Codex']);
    expect(texts).toContain('2 Bots not set up');
    expect(texts).not.toContain('No backend currently reports routine support.');
  } finally {
    act(() => renderer?.unmount());
  }
});
